/**
 * 下書きを 1 件選ぶ。**位置指定（index）で別の商品を掴まないための番人。**
 *
 * `index` は配列の位置でしかない。一覧を見てから渡すまでの間に下書きが 1 件でも
 * 消えれば、後ろの位置は 1 つずつ繰り上がり、**同じ番号が別の商品を指す**。
 * エラーにならないまま別の商品がメルカリへ流れるため、消失より厄介になりうる。
 *
 * ここでやるのは 3 つだけ。
 * - `draft_id` での指名は、見つからなければ止める（消失の検出点）
 * - 位置指定に裏取り（`draft_id` の併記、または `expect_id`）があれば突き合わせる
 * - 裏取りが無い位置指定は、通すが**黙って通さない**（warnings に必ず出す）
 *
 * 推測して選び直すことはしない。ズレたら止める。
 */

/** 下書きの id は数値のことも文字列のこともある。比較は文字列で揃える */
const sameId = (a, b) => a != null && b != null && String(a) === String(b);

/** 一覧に出す用の短い姿。エラー文面へ埋める */
const brief = (d, index) =>
  d == null ? null : { index, id: d.id ?? null, title: d.title ?? null };

/**
 * @param {object} params
 * @param {Array<object>} params.drafts 下書きの配列（`resolveDrafts` が返すそのまま）
 * @param {number|string} [params.draftId] 下書きの id での指名
 * @param {number} [params.index] 位置指定
 * @param {number|string} [params.expectId] 位置指定の裏取り。`drafts[index]` の id がこれと一致することを求める
 * @returns {{ok: true, draft: object, index: number, warnings: Array<object>}
 *          |{ok: false, code: string, message: string, detail?: object}}
 */
export function selectDraft({ drafts, draftId, index, expectId } = {}) {
  const list = Array.isArray(drafts) ? drafts : [];
  const hasId = draftId != null && draftId !== '';
  const hasIndex = Number.isInteger(index);
  const hasExpect = expectId != null && expectId !== '';

  if (!hasId && !hasIndex) {
    return {
      ok: false,
      code: 'BAD_PARAMS',
      message: 'draft_id か index のどちらかが必要です（消失や取り違えを防ぐため draft_id を推奨）',
    };
  }

  if (hasExpect && !hasIndex) {
    return {
      ok: false,
      code: 'BAD_PARAMS',
      message: 'expect_id は index の裏取りです。index と一緒に渡してください',
    };
  }

  const byIndex = hasIndex ? (list[index] ?? null) : null;

  // 位置指定が範囲外。一覧を取り直した後に下書きが減ると起きる
  if (hasIndex && byIndex == null) {
    return {
      ok: false,
      code: 'DRAFT_NOT_FOUND',
      message:
        `index ${index} に下書きがありません（${list.length} 件中）。` +
        '一覧を取り直してから draft_id で指名してください',
      detail: { index, count: list.length },
    };
  }

  if (hasId) {
    const byId = list.find((x) => sameId(x?.id, draftId)) ?? null;

    // 指名した下書きが無い。**消失の検出点。** 位置で拾い直すことはしない
    if (byId == null) {
      return {
        ok: false,
        code: 'DRAFT_NOT_FOUND',
        message:
          `draft_id ${draftId} の下書きがありません（${list.length} 件中）。` +
          '消えたか、別の環境の一覧を見ている可能性があります',
        detail: { draftId, count: list.length },
      };
    }

    // id と位置の両方を渡されたら突き合わせる。食い違えば止める
    if (hasIndex && byIndex !== byId) {
      return {
        ok: false,
        code: 'DRAFT_MISMATCH',
        message:
          `draft_id ${draftId} と index ${index} が別の下書きを指しています。` +
          '一覧を取り直してください（下書きが増減すると位置がずれます）',
        detail: { byDraftId: brief(byId, list.indexOf(byId)), byIndex: brief(byIndex, index) },
      };
    }

    return { ok: true, draft: byId, index: list.indexOf(byId), warnings: [] };
  }

  // ここから先は位置指定のみ
  if (hasExpect && !sameId(byIndex?.id, expectId)) {
    return {
      ok: false,
      code: 'DRAFT_MISMATCH',
      message:
        `index ${index} の下書きは expect_id ${expectId} と一致しません。` +
        '一覧を取り直してください（下書きが増減すると位置がずれます）',
      detail: { expectId, found: brief(byIndex, index) },
    };
  }

  const warnings = hasExpect
    ? []
    : [{
        code: 'INDEX_UNVERIFIED',
        message:
          `index ${index} を裏取りなしで解決しました（「${byIndex.title ?? '（タイトルなし）'}」）。` +
          '一覧取得後に下書きが増減していると別の商品を指します。draft_id での指名を推奨します',
      }];

  return { ok: true, draft: byIndex, index, warnings };
}
