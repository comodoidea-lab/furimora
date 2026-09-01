#!/usr/bin/env node
/** reconcile.js の単体テスト（ログイン不要・合成データ） */
import { reconcileListings, extractMercariItemId } from '../public/js/reconcile.js';

let ng = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? '✅' : '❌'} ${name}${ok ? '' : `  期待 ${JSON.stringify(want)} / 実際 ${JSON.stringify(got)}`}`);
  if (!ok) ng++;
};

console.log('\n── ID 抽出 ──');
eq('mercariItemId から', extractMercariItemId({ mercariItemId: 'm12345678901' }), 'm12345678901');
eq('mercariUrl から', extractMercariItemId({ mercariUrl: 'https://jp.mercari.com/item/m98765432109?x=1' }), 'm98765432109');
eq('url から', extractMercariItemId({ url: 'https://jp.mercari.com/item/m11111111111' }), 'm11111111111');
eq('未設定は null', extractMercariItemId({ title: 'なにか' }), null);
eq('不正な形式は null', extractMercariItemId({ mercariItemId: 'abc' }), null);

console.log('\n── 突き合わせ ──');
const local = [
  { mercariItemId: 'm10000000001', title: '売れてるのに出品中のまま', status: 'active',   currentPrice: 2000 },
  { mercariItemId: 'm10000000002', title: '価格がズレている',           status: 'active',   currentPrice: 3000 },
  { mercariItemId: 'm10000000003', title: '一致している',               status: 'active',   currentPrice: 1500 },
  { mercariItemId: 'm10000000004', title: 'メルカリから消えている',     status: 'active',   currentPrice: 900  },
  { mercariItemId: 'm10000000005', title: '再出品したのに売却済みのまま', status: 'sold',    currentPrice: 800  },
  { title: 'URL未設定',                                                  status: 'active',   currentPrice: 500  },
];
const remoteActive = [
  { itemId: 'm10000000002', title: '価格がズレている', currentPrice: 2700 },
  { itemId: 'm10000000003', title: '一致している',     currentPrice: 1500 },
  { itemId: 'm10000000005', title: '再出品した',       currentPrice: 850  },
  { itemId: 'm10000000009', title: 'アプリに無い出品', currentPrice: 4000 },
];
const remoteSold = [{ itemId: 'm10000000001', title: '売れてるのに出品中のまま', currentPrice: 2000 }];

const r = reconcileListings({ local, remoteActive, remoteSold });
eq('売れているのに出品中', r.soldButActive.map(x => x.itemId), ['m10000000001']);
eq('価格のズレ', r.priceMismatch.map(x => [x.itemId, x.diff]), [['m10000000002', -300]]);
eq('メルカリから消えている', r.missingRemotely.map(x => x.itemId), ['m10000000004']);
eq('再出品済みなのに売却済み扱い', r.relistedButSold.map(x => x.itemId), ['m10000000005']);
eq('アプリに無い出品', r.missingLocally.map(x => x.itemId), ['m10000000009']);
eq('ID未設定', r.unlinked.length, 1);
eq('一致件数', r.summary.matchedCount, 1);

console.log('\n── 打ち切り時の安全側フォールバック ──');
const t = reconcileListings({ local, remoteActive, remoteSold, remoteTruncated: true });
eq('打ち切り時は「消えている」を出さない', t.missingRemotely.length, 0);
eq('打ち切り時は売却検出は続ける', t.soldButActive.length, 1);
eq('打ち切りの注記が出る', t.summary.notes.length, 1);

console.log('\n── 価格の許容差 ──');
const tol = reconcileListings({ local, remoteActive, remoteSold, priceTolerance: 500 });
eq('許容差内はズレ扱いしない', tol.priceMismatch.length, 0);

console.log('\n── 空入力 ──');
const e = reconcileListings({ local: [], remoteActive: [] });
eq('空でも落ちない', e.summary.localCount, 0);

console.log(ng ? `\n${ng} 件失敗\n` : '\nすべて成功\n');
process.exit(ng ? 1 : 0);
