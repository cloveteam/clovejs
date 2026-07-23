import { get } from "clovejs"

// A self-contained browser demo, served at /api. It opens an EventSource on the
// `demo` channel, renders events as they arrive, and posts new ones back over
// HTTP — so you can watch the HTTP -> stream bridge live in two browser tabs.
//
// Returning HTML is just a matter of setting the content type; that opts the
// route out of the JSON middleware, and the string is sent as-is.
export default get(async (_req, res) => {
  res.type("html")
  return PAGE
})

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>CloveJS — SSE demo</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 44rem; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.3rem; margin-bottom: 0.25rem; }
  .sub { opacity: 0.7; margin-top: 0; }
  .bar { display: flex; gap: 0.5rem; align-items: center; margin: 1rem 0; }
  .dot { width: 0.6rem; height: 0.6rem; border-radius: 50%; background: #b0b0b0; }
  .dot.live { background: #35c46a; }
  form { display: flex; gap: 0.5rem; margin: 1rem 0; }
  select, input, button { font: inherit; padding: 0.4rem 0.6rem; border-radius: 6px; border: 1px solid #8886; background: transparent; color: inherit; }
  input { flex: 1; }
  button { cursor: pointer; }
  ul { list-style: none; padding: 0; }
  li { border: 1px solid #8883; border-radius: 8px; padding: 0.5rem 0.7rem; margin-bottom: 0.5rem; }
  .type { font-weight: 600; }
  .type.alert { color: #e0533d; }
  .type.note { color: #3d7fe0; }
  .meta { opacity: 0.6; font-size: 0.85em; }
  code { background: #8882; padding: 0.1rem 0.3rem; border-radius: 4px; }
</style>
</head>
<body>
  <h1>CloveJS — Server-Sent Events</h1>
  <p class="sub">Live feed on channel <code>demo</code>. Open a second tab to watch events fan out.</p>

  <div class="bar">
    <span class="dot" id="dot"></span>
    <span id="status">connecting…</span>
    <span class="meta" id="clock"></span>
  </div>

  <form id="publish">
    <select id="type">
      <option value="message">message</option>
      <option value="note">note</option>
      <option value="alert">alert</option>
    </select>
    <input id="text" placeholder="Say something…" autocomplete="off" />
    <button type="submit">Publish</button>
  </form>

  <ul id="events"></ul>

<script>
  var dot = document.getElementById('dot');
  var status = document.getElementById('status');
  var list = document.getElementById('events');

  function render(kind, event) {
    var payload = JSON.parse(event.data);
    var li = document.createElement('li');
    var head = document.createElement('div');
    head.innerHTML = '<span class="type ' + kind + '">' + kind + '</span> ' +
      '<span class="meta">#' + payload.seq + ' · ' + new Date(payload.at).toLocaleTimeString() + '</span>';
    var body = document.createElement('div');
    body.textContent = typeof payload.data === 'object' ? JSON.stringify(payload.data) : String(payload.data);
    li.appendChild(head);
    li.appendChild(body);
    list.insertBefore(li, list.firstChild);
  }

  // One EventSource, three named events. The browser reconnects on its own and
  // replays what was missed using the last id it saw.
  var es = new EventSource('/api/channels/demo/stream');
  es.onopen = function () { dot.classList.add('live'); status.textContent = 'live'; };
  es.onerror = function () { dot.classList.remove('live'); status.textContent = 'reconnecting…'; };
  ['message', 'note', 'alert'].forEach(function (kind) {
    es.addEventListener(kind, function (e) { render(kind, e); });
  });

  // The clock stream is the minimal case: default 'message' events, once a second.
  var clockEs = new EventSource('/api/clock');
  clockEs.onmessage = function (e) {
    document.getElementById('clock').textContent = 'server: ' + JSON.parse(e.data).now.slice(11, 19);
  };

  document.getElementById('publish').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var type = document.getElementById('type').value;
    var input = document.getElementById('text');
    fetch('/api/channels/demo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: type, data: { text: input.value || '(empty)' } })
    });
    input.value = '';
  });
</script>
</body>
</html>
`
