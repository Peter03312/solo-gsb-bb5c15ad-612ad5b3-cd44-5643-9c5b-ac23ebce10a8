import { PoolClient } from 'pg';
import {
  BatchEditDTO,
  BatchEditFragmentPlan,
  BatchEditLineBasis,
  BatchEditLinePlan,
  BatchEditPlan,
  BatchEditPlanItem,
  BatchEditAffectedGroup,
  DocumentRow,
  FragmentRow,
  GroupRow,
  LineRow,
  ManuscriptRow,
} from './types';
import { charLen, HttpError, isInt, sliceCp } from './util';

/**
 * 批量改字：一次提交同一文献多份抄本多条原始行的非空编辑列表。
 *
 * 关键语义：
 *  - 所有位置一律按“改前原文”的 Unicode 码点左闭右开区间给出；同一行的编辑按原坐标
 *    **同时生效**（不按顺序链式应用）。
 *  - 同行冲突整批拒绝：替换/删除区间相互重叠（端点相接允许）、同点重复插入、
 *    插入点落在其他编辑区间内部或端点上。
 *  - 片段处理：与非插入编辑区间相交、或插入点严格位于片段内部、或平移后越界 → 所在组
 *    待修复（片段保留原坐标，待人工修复）；插入点在片段边界仅平移片段；不相交片段按
 *    累计位移整体平移；原已待修复组与缺文标记绝不由本次改动自动改好。
 *  - 预览只读；提交须携带 expectedVersion 与预览返回的 basis，任一不符整批拒绝、不写入。
 */

export interface BatchEditIssue {
  code:
    | 'LINE_NOT_FOUND'
    | 'LINE_NOT_IN_DOC'
    | 'OUT_OF_RANGE'
    | 'EDIT_OVERLAP'
    | 'SAME_POINT_INSERTION'
    | 'INSERT_INSIDE_EDIT'
    | 'INSERT_AT_EDIT_ENDPOINT';
  message: string;
  index?: number;
  otherIndex?: number;
  lineId?: number;
  lineNo?: number;
  startCp?: number;
  endCp?: number;
}

interface LoadedEdit extends BatchEditDTO {
  index: number;
}

export interface BatchEditData {
  doc: DocumentRow;
  mss: ManuscriptRow[];
  lines: LineRow[];
  fragments: FragmentRow[];
  groupById: Map<number, GroupRow>;
}

async function loadBatchData(
  client: PoolClient,
  doc: DocumentRow,
  lineIds: number[],
  forUpdate: boolean
): Promise<BatchEditData> {
  const { rows: mss } = await client.query<ManuscriptRow>(
    'SELECT id, doc_id, name, position FROM manuscripts WHERE doc_id=$1 ORDER BY position, id',
    [doc.id]
  );
  const ids = [...new Set(lineIds)];
  const { rows: lines } = await client.query<LineRow>(
    `SELECT id, ms_id, line_no, content FROM lines WHERE id = ANY($1::bigint[])${forUpdate ? ' ORDER BY id FOR UPDATE' : ''}`,
    [ids]
  );
  const { rows: fragments } = await client.query<FragmentRow>(
    `SELECT id, group_id, doc_id, ms_id, line_id, start_cp, end_cp, missing
     FROM fragments WHERE doc_id=$1 AND line_id = ANY($2::bigint[]) AND missing=FALSE
     ORDER BY line_id, start_cp, id`,
    [doc.id, ids]
  );
  const gids = [...new Set(fragments.map((f) => f.group_id))];
  const groupById = new Map<number, GroupRow>();
  if (gids.length > 0) {
    const { rows: grps } = await client.query<GroupRow>(
      'SELECT id, doc_id, ord, broken FROM grp WHERE id = ANY($1::bigint[])',
      [gids]
    );
    for (const g of grps) groupById.set(g.id, g);
  }
  return { doc, mss, lines, fragments, groupById };
}

/** 计算整批计划（预览 / 提交共用）。任何行不存在 / 跨行 / 区间非法 / 同行冲突 → 400 逐条定位。 */
export async function buildBatchEditPlan(
  client: PoolClient,
  doc: DocumentRow,
  edits: BatchEditDTO[],
  forUpdate: boolean
): Promise<{ plan: BatchEditPlan; data: BatchEditData }> {
  const loaded: LoadedEdit[] = edits.map((e, index) => ({ ...e, index }));
  const data = await loadBatchData(
    client,
    doc,
    loaded.map((e) => e.lineId),
    forUpdate
  );
  const { mss, lines, fragments, groupById } = data;
  const msById = new Map(mss.map((m) => [m.id, m]));
  const lineById = new Map(lines.map((l) => [l.id, l]));

  const issues: BatchEditIssue[] = [];

  // 1) 行存在性 / 归属（按编辑项逐条定位；同一行的多个编辑会重复报出，便于逐项修正）
  const editLineOf = new Map<number, LineRow>();
  for (const e of loaded) {
    const ln = lineById.get(e.lineId);
    if (!ln) {
      issues.push({
        code: 'LINE_NOT_FOUND',
        message: `第 ${e.index + 1} 项编辑引用的行 #${e.lineId} 不存在（可能已被删除）`,
        index: e.index,
        lineId: e.lineId,
      });
      continue;
    }
    const ms = msById.get(ln.ms_id);
    if (!ms || ms.doc_id !== doc.id) {
      issues.push({
        code: 'LINE_NOT_IN_DOC',
        message: `第 ${e.index + 1} 项编辑引用的行 #${e.lineId} 不属于本文献的抄本，不能与本文献其他行同批校订`,
        index: e.index,
        lineId: e.lineId,
      });
      continue;
    }
    editLineOf.set(e.lineId, ln);
  }

  // 2) 按行分组，逐行做区间合法性与同批冲突检测
  const byLine = new Map<number, LoadedEdit[]>();
  for (const e of loaded) {
    if (!editLineOf.has(e.lineId)) continue; // 前述已报
    const arr = byLine.get(e.lineId) ?? [];
    arr.push(e);
    byLine.set(e.lineId, arr);
  }

  const validByLine = new Map<number, LoadedEdit[]>();
  for (const [lineId, eds] of byLine) {
    const ln = editLineOf.get(lineId) as LineRow;
    const len = charLen(ln.content);
    const inRange: LoadedEdit[] = [];
    for (const e of eds) {
      if (e.startCp > len || e.endCp > len) {
        issues.push({
          code: 'OUT_OF_RANGE',
          message:
            `第 ${e.index + 1} 项编辑区间越界：抄本「${msById.get(ln.ms_id)?.name}」第 ${ln.line_no} 行共 ${len} 字，` +
            `收到 [${e.startCp}, ${e.endCp})（按 Unicode 码点，左闭右开；合法端点为 0–${len}）`,
          index: e.index,
          lineId,
          lineNo: ln.line_no,
          startCp: e.startCp,
          endCp: e.endCp,
        });
      } else {
        inRange.push(e);
      }
    }

    // 两两冲突检测（同一行按原坐标同时生效）；即使有越界项也照常检测，便于一次返回全部问题
    const conflictPairs = new Set<string>();
    const addIssue = (iss: BatchEditIssue) => {
      const key = `${iss.code}:${iss.index}:${iss.otherIndex ?? ''}`;
      if (conflictPairs.has(key)) return;
      conflictPairs.add(key);
      issues.push(iss);
    };
    for (let i = 0; i < eds.length; i++) {
      for (let j = i + 1; j < eds.length; j++) {
        const a = eds[i];
        const b = eds[j];
        const aIns = a.startCp === a.endCp;
        const bIns = b.startCp === b.endCp;
        const pos = (idx: number, cp: number) =>
          `第 ${idx + 1} 项（抄本「${msById.get(ln.ms_id)?.name}」第 ${ln.line_no} 行第 ${cp} 码点处）`;
        if (aIns && bIns) {
          if (a.startCp === b.startCp) {
            addIssue({
              code: 'SAME_POINT_INSERTION',
              message:
                `同点重复插入：${pos(a.index, a.startCp)}与${pos(b.index, b.startCp)}` +
                `都在第 ${a.startCp} 码点处插入，同批只允许一处`,
              index: b.index,
              otherIndex: a.index,
              lineId,
              lineNo: ln.line_no,
              startCp: a.startCp,
              endCp: a.startCp,
            });
          }
        } else if (aIns) {
          // 插入点 a.startCp 相对替换/删除区间 b：严格内部拒绝；落在端点也拒绝
          if (b.startCp < a.startCp && a.startCp < b.endCp) {
            addIssue({
              code: 'INSERT_INSIDE_EDIT',
              message:
                `插入点落在其他编辑区间内部：${pos(a.index, a.startCp)}的插入位于` +
                `第 ${b.index + 1} 项区间 [${b.startCp}, ${b.endCp}) 内部，请合并为一次替换`,
              index: a.index,
              otherIndex: b.index,
              lineId,
              lineNo: ln.line_no,
              startCp: a.startCp,
              endCp: a.startCp,
            });
          } else if (a.startCp === b.startCp || a.startCp === b.endCp) {
            addIssue({
              code: 'INSERT_AT_EDIT_ENDPOINT',
              message:
                `插入点落在其他编辑区间端点：${pos(a.index, a.startCp)}的插入与第 ${b.index + 1} 项区间` +
                ` [${b.startCp}, ${b.endCp}) 的端点重合（边界语义不明），请改为一次替换或错开插入点`,
              index: a.index,
              otherIndex: b.index,
              lineId,
              lineNo: ln.line_no,
              startCp: a.startCp,
              endCp: a.startCp,
            });
          }
        } else if (bIns) {
          if (a.startCp < b.startCp && b.startCp < a.endCp) {
            addIssue({
              code: 'INSERT_INSIDE_EDIT',
              message:
                `插入点落在其他编辑区间内部：${pos(b.index, b.startCp)}的插入位于` +
                `第 ${a.index + 1} 项区间 [${a.startCp}, ${a.endCp}) 内部，请合并为一次替换`,
              index: b.index,
              otherIndex: a.index,
              lineId,
              lineNo: ln.line_no,
              startCp: b.startCp,
              endCp: b.startCp,
            });
          } else if (b.startCp === a.startCp || b.startCp === a.endCp) {
            addIssue({
              code: 'INSERT_AT_EDIT_ENDPOINT',
              message:
                `插入点落在其他编辑区间端点：${pos(b.index, b.startCp)}的插入与第 ${a.index + 1} 项区间` +
                ` [${a.startCp}, ${a.endCp}) 的端点重合（边界语义不明），请改为一次替换或错开插入点`,
              index: b.index,
              otherIndex: a.index,
              lineId,
              lineNo: ln.line_no,
              startCp: b.startCp,
              endCp: b.startCp,
            });
          }
        } else if (Math.max(a.startCp, b.startCp) < Math.min(a.endCp, b.endCp)) {
          // 两个非插入区间内部相交（端点相接允许）
          addIssue({
            code: 'EDIT_OVERLAP',
            message:
              `同行编辑区间重叠：第 ${a.index + 1} 项 [${a.startCp}, ${a.endCp}) 与第 ${b.index + 1} 项` +
              ` [${b.startCp}, ${b.endCp}) 在抄本「${msById.get(ln.ms_id)?.name}」第 ${ln.line_no} 行` +
              `第 ${Math.max(a.startCp, b.startCp) + 1}–${Math.min(a.endCp, b.endCp)} 字重叠`,
            index: b.index,
            otherIndex: a.index,
            lineId,
            lineNo: ln.line_no,
            startCp: Math.max(a.startCp, b.startCp),
            endCp: Math.min(a.endCp, b.endCp),
          });
        }
      }
    }
    if (issues.some((x) => x.lineId === lineId)) continue;
    validByLine.set(lineId, inRange);
  }

  if (issues.length > 0) {
    throw new HttpError(400, `批量校订未通过：${issues.length} 处问题，已整批拒绝、未写入任何内容`, issues);
  }

  // 3) 逐行同时生效：新文字、编辑落位
  const linePlans: BatchEditLinePlan[] = [];
  for (const [lineId, eds0] of [...validByLine.entries()].sort((a, b) => a[0] - b[0])) {
    const ln = editLineOf.get(lineId) as LineRow;
    const ms = msById.get(ln.ms_id) as ManuscriptRow;
    const oldContent = ln.content;
    const oldLen = charLen(oldContent);
    const deltaOf = (e: LoadedEdit) => charLen(e.replacement) - (e.endCp - e.startCp);
    // 起点排序：端点不可能重合（插入点不得落在任何区间端点；非插入区间至多端点相接）
    const sorted = [...eds0].sort((a, b) => a.startCp - b.startCp || a.endCp - b.endCp);

    const parts: string[] = [];
    let cursor = 0;
    for (const e of sorted) {
      if (e.startCp > cursor) parts.push(sliceCp(oldContent, cursor, e.startCp));
      parts.push(e.replacement);
      if (e.endCp > cursor) cursor = e.endCp;
    }
    parts.push(sliceCp(oldContent, cursor, oldLen));
    const newContent = parts.join('');
    const newLen = charLen(newContent);

    const items: BatchEditPlanItem[] = sorted.map((e) => {
      // 落位：其起点之前（含端点相接）的其他编辑累计位移
      const lead = loaded
        .filter((o) => o.index !== e.index && o.lineId === lineId && o.endCp <= e.startCp)
        .reduce((sum, o) => sum + deltaOf(o), 0);
      const resultStart = e.startCp + lead;
      const rlen = charLen(e.replacement);
      return {
        index: e.index,
        lineId,
        msId: ms.id,
        msName: ms.name,
        lineNo: ln.line_no,
        kind: e.startCp === e.endCp ? ('insert' as const) : ('replace' as const),
        startCp: e.startCp,
        endCp: e.endCp,
        replacement: e.replacement,
        replacementLengthCp: rlen,
        deltaCp: deltaOf(e),
        resultStartCp: resultStart,
        resultEndCp: resultStart + rlen,
      };
    });

    linePlans.push({
      lineId,
      msId: ms.id,
      msName: ms.name,
      lineNo: ln.line_no,
      oldContent,
      newContent,
      oldLengthCp: oldLen,
      newLengthCp: newLen,
      edits: items,
    });
  }

  // 4) 受影响行上的现存片段：相交 / 内部插入 / 平移越界 → 待修复；否则按累计位移平移
  const fragmentPlans: BatchEditFragmentPlan[] = [];
  const linePlanById = new Map(linePlans.map((p) => [p.lineId, p]));
  const affectedMap = new Map<
    number,
    { group: GroupRow; newlyBroken: boolean; reasons: string[] }
  >();

  for (const f of fragments) {
    if (f.line_id == null || f.start_cp == null || f.end_cp == null) continue;
    const lp = linePlanById.get(f.line_id);
    if (!lp) continue; // 该行的编辑此前全部被判非法时不会出现（已整体抛错）
    const ln = editLineOf.get(f.line_id) as LineRow;
    const ms = msById.get(f.ms_id);
    const grp = groupById.get(f.group_id);
    if (!ms || !grp) continue;
    const fS = f.start_cp;
    const fE = f.end_cp;
    const eds = validByLine.get(f.line_id) ?? [];

    const base = {
      fragmentId: f.id,
      groupId: grp.id,
      groupOrd: grp.ord,
      groupAlreadyBroken: grp.broken,
      msId: ms.id,
      msName: ms.name,
      lineId: f.line_id,
      lineNo: ln.line_no,
      oldStartCp: fS,
      oldEndCp: fE,
    };

    const intersectRange = eds.find(
      (e) => e.startCp !== e.endCp && fS < e.endCp && e.startCp < fE
    );
    const insideInsert = eds.find(
      (e) => e.startCp === e.endCp && fS < e.startCp && e.startCp < fE
    );

    const markAffected = (newly: boolean, reason: string) => {
      const cur = affectedMap.get(grp.id);
      if (!cur) affectedMap.set(grp.id, { group: grp, newlyBroken: newly, reasons: [reason] });
      else if (newly) cur.newlyBroken = true;
      if (cur && !cur.reasons.includes(reason)) cur.reasons.push(reason);
    };

    if (intersectRange) {
      const e = intersectRange;
      fragmentPlans.push({
        ...base,
        status: 'broken',
        newLineId: null,
        newStartCp: null,
        newEndCp: null,
        note: `片段 [${fS}, ${fE}) 与编辑区间 [${e.startCp}, ${e.endCp}) 相交，保留原坐标待人工修复`,
      });
      markAffected(
        !grp.broken,
        grp.broken
          ? '组原已待修复，本次改动后保持待修复（不自动转完好）'
          : `第 ${grp.ord} 组片段 [${fS}, ${fE}) 与编辑区间 [${e.startCp}, ${e.endCp}) 相交，标为待修复`
      );
      continue;
    }
    if (insideInsert) {
      const p = insideInsert.startCp;
      fragmentPlans.push({
        ...base,
        status: 'broken',
        newLineId: null,
        newStartCp: null,
        newEndCp: null,
        note: `插入点 ${p} 严格位于片段 [${fS}, ${fE}) 内部，保留原坐标待人工修复`,
      });
      markAffected(
        !grp.broken,
        grp.broken
          ? '组原已待修复，本次改动后保持待修复（不自动转完好）'
          : `第 ${grp.ord} 组片段 [${fS}, ${fE}) 内部第 ${p} 码点处有插入，标为待修复`
      );
      continue;
    }

    // 不相交：完全位于片段起点之前（endCp ≤ fS，端点相接计入）的编辑累计位移
    const shift = eds
      .filter((e) => e.endCp <= fS)
      .reduce((sum, e) => sum + (charLen(e.replacement) - (e.endCp - e.startCp)), 0);
    const ns = fS + shift;
    const ne = fE + shift;
    const newLen = lp.newLengthCp;
    const oob = ns < 0 || ne <= ns || ns >= newLen || ne > newLen;
    if (oob) {
      fragmentPlans.push({
        ...base,
        status: 'broken',
        newLineId: null,
        newStartCp: null,
        newEndCp: null,
        note: `片段按累计位移平移到 [${ns}, ${ne}) 后越界（该行新长度 ${newLen} 字），保留原坐标待人工修复`,
      });
      markAffected(
        !grp.broken,
        grp.broken
          ? '组原已待修复，本次改动后保持待修复（不自动转完好）'
          : `第 ${grp.ord} 组片段 [${fS}, ${fE}) 平移后越界（新长度 ${newLen} 字），标为待修复`
      );
      continue;
    }

    if (shift === 0) {
      fragmentPlans.push({
        ...base,
        status: 'unchanged',
        newLineId: f.line_id,
        newStartCp: fS,
        newEndCp: fE,
        note: '片段位于所有改动之前/之后且位移为 0，位置不变',
      });
    } else {
      fragmentPlans.push({
        ...base,
        status: 'shifted',
        newLineId: f.line_id,
        newStartCp: ns,
        newEndCp: ne,
        note:
          `片段不与任何编辑相交，按累计位移平移 ${shift} 个码点` +
          (eds.some((e) => e.startCp === e.endCp && e.startCp === fS)
            ? '（插入点位于片段起点边界，仅平移，不标待修复）'
            : ''),
      });
    }
    if (grp.broken) {
      markAffected(false, '组原已待修复，本次改动后保持待修复（不自动转完好）');
    }
  }

  const affectedGroups: BatchEditAffectedGroup[] = [...affectedMap.values()]
    .map(({ group, newlyBroken, reasons }) => ({
      groupId: group.id,
      ord: group.ord,
      newlyBroken,
      reason: reasons.join('；'),
    }))
    .sort((a, b) => a.ord - b.ord);

  const basis: BatchEditLineBasis[] = linePlans
    .map((p) => ({
      lineId: p.lineId,
      msId: p.msId,
      lineNo: p.lineNo,
      content: p.oldContent,
      lengthCp: p.oldLengthCp,
    }))
    .sort((a, b) => a.lineId - b.lineId);

  return { plan: { lines: linePlans, fragments: fragmentPlans, affectedGroups, basis }, data };
}

/**
 * 提交时先于区间语义计算核对预览依据：直接对照数据库当前行。
 *  - basis 缺失 / 非数组 / 项形状错 → 400；
 *  - basis 覆盖行集合与本次 edits 涉及行不一致（含行删除 / 重复 / 张冠李戴）→ 409 BATCH_EDIT_STALE；
 *  - 任一行内容 / 行号 / 抄本归属与当前不符 → 409 BATCH_EDIT_STALE。
 * 先于越界 / 冲突检测执行，保证“预览后行已变化”一律报过期（409），而非 400。
 */
export async function verifyBasisCurrent(
  client: PoolClient,
  doc: DocumentRow,
  given: unknown,
  expectedLineIds: number[]
): Promise<void> {
  if (!Array.isArray(given)) {
    throw new HttpError(400, '缺少 basis：请原样带回预览响应中的 basis，以确认预览所依据的行未变化');
  }
  const expectedIds = [...new Set(expectedLineIds)].sort((a, b) => a - b);
  const givenBasis: BatchEditLineBasis[] = [];
  const seen = new Set<number>();
  for (const raw of given) {
    const g = raw as Partial<BatchEditLineBasis>;
    if (
      !g || typeof g !== 'object' || !isInt(g.lineId) || !isInt(g.msId) ||
      !isInt(g.lineNo) || typeof g.content !== 'string' || !isInt(g.lengthCp)
    ) {
      throw new HttpError(400, 'basis 格式有误：每项须含 lineId/msId/lineNo/content/lengthCp');
    }
    if (seen.has(g.lineId)) {
      throw new HttpError(400, 'basis 中同一行出现多次，请原样带回预览响应中的 basis');
    }
    seen.add(g.lineId);
    givenBasis.push(g as BatchEditLineBasis);
  }
  const givenIds = [...seen].sort((a, b) => a - b);
  const setMismatch =
    givenIds.length !== expectedIds.length || givenIds.some((id, i) => id !== expectedIds[i]);

  const { rows: lines } = await client.query<LineRow>(
    'SELECT id, ms_id, line_no, content FROM lines WHERE id = ANY($1::bigint[])',
    [expectedIds]
  );
  const lineById = new Map(lines.map((l) => [l.id, l]));
  const { rows: mss } = await client.query<ManuscriptRow>(
    'SELECT id FROM manuscripts WHERE doc_id=$1',
    [doc.id]
  );
  const msIds = new Set(mss.map((m) => m.id));

  const mismatched: Array<{ lineId: number; fields: string[] }> = [];
  if (setMismatch) {
    for (const id of givenIds) if (!expectedIds.includes(id)) mismatched.push({ lineId: id, fields: ['lineId'] });
    for (const id of expectedIds) if (!givenIds.includes(id)) mismatched.push({ lineId: id, fields: ['lineId'] });
  }
  for (const g of givenBasis) {
    if (!expectedIds.includes(g.lineId)) continue;
    const ln = lineById.get(g.lineId);
    if (!ln || !msIds.has(ln.ms_id)) {
      mismatched.push({ lineId: g.lineId, fields: ['lineId'] });
      continue;
    }
    const actual: BatchEditLineBasis = {
      lineId: ln.id,
      msId: ln.ms_id,
      lineNo: ln.line_no,
      content: ln.content,
      lengthCp: charLen(ln.content),
    };
    const fields: string[] = [];
    (['msId', 'lineNo', 'content', 'lengthCp'] as const).forEach((k) => {
      if (JSON.stringify(g[k]) !== JSON.stringify(actual[k])) fields.push(k);
    });
    if (fields.length > 0) mismatched.push({ lineId: g.lineId, fields });
  }
  const uniq = new Map<number, string[]>();
  for (const m of mismatched) if (!uniq.has(m.lineId)) uniq.set(m.lineId, m.fields);
  if (uniq.size > 0) {
    throw new HttpError(
      409,
      '预览所依据的行已变化，已整批拒绝、未写入任何内容，请重新预览后再确认',
      { code: 'BATCH_EDIT_STALE', mismatched: [...uniq].map(([lineId, fields]) => ({ lineId, fields })) }
    );
  }
}

/** 应用计划：更新各行新文字、平移未受影响片段、仅把“新标待修复”的组置 broken。 */
export async function applyBatchEditPlan(
  client: PoolClient,
  plan: BatchEditPlan
): Promise<void> {
  for (const lp of plan.lines) {
    await client.query('UPDATE lines SET content=$1 WHERE id=$2', [lp.newContent, lp.lineId]);
  }
  for (const f of plan.fragments) {
    if (f.status !== 'shifted') continue; // unchanged 坐标不变；broken 保留原坐标
    await client.query('UPDATE fragments SET start_cp=$1, end_cp=$2 WHERE id=$3', [
      f.newStartCp,
      f.newEndCp,
      f.fragmentId,
    ]);
  }
  const newlyBroken = plan.affectedGroups.filter((g) => g.newlyBroken).map((g) => g.groupId);
  if (newlyBroken.length > 0) {
    await client.query('UPDATE grp SET broken=TRUE WHERE id = ANY($1::bigint[])', [newlyBroken]);
  }
}
