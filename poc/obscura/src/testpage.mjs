/** PoC 用のローカルテストページ（入力・クリック・DOM 更新・Cookie を検証する） */
import http from 'node:http';

export function startTestServer() {
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>PoC テストページ</title></head>
<body>
  <h1 id="heading">こんにちは</h1>
  <input id="name-input" type="text" placeholder="名前" />
  <button id="submit-btn">送信</button>
  <p id="result"></p>
  <script>
    document.cookie = 'furimora_poc_local=1; path=/; max-age=3600';
    document.getElementById('submit-btn').addEventListener('click', () => {
      const v = document.getElementById('name-input').value;
      setTimeout(() => {
        const p = document.createElement('p');
        p.id = 'async-result';
        p.textContent = 'こんにちは、' + v + 'さん';
        document.body.appendChild(p);
      }, 300);
      document.getElementById('result').textContent = '受信: ' + v;
    });
  </script>
</body></html>`;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}/`, close: () => server.close() });
    });
  });
}
