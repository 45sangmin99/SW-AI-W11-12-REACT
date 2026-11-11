export const initialDocument = `<!doctype html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>길찾기</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; padding: 24px; color: #233044; background: #f8fafc; font-family: sans-serif; }
    main { max-width: 760px; margin: auto; }
    h1 { margin: 0 0 8px; font-size: 24px; }
    p { line-height: 1.6; }
    .toolbar, .legend { display: flex; flex-wrap: wrap; gap: 8px; margin: 16px 0; }
    .toolbar button { border: 1px solid #cbd5e1; border-radius: 6px; padding: 9px 12px; background: white; color: inherit; cursor: pointer; }
    .toolbar button[aria-pressed="true"] { border-color: #2563eb; background: #dbeafe; }
    .toolbar button:disabled { opacity: .45; cursor: default; }
    .grid { display: grid; grid-template-columns: repeat(18, minmax(0, 1fr)); gap: 2px; padding: 2px; border: 1px solid #cbd5e1; background: #e2e8f0; touch-action: none; user-select: none; }
    .cell { aspect-ratio: 1; min-width: 0; padding: 0; border: 0; background: white; color: #334155; font-size: clamp(9px, 2vw, 14px); cursor: crosshair; }
    .cell.visited { background: #bfdbfe; }
    .cell.frontier { background: #c4b5fd; }
    .cell.path { background: #facc15; }
    .cell.wall { background: #334155; }
    .cell.start { background: #16a34a; color: white; }
    .cell.end { background: #e11d48; color: white; }
    .cell:focus-visible { outline: 3px solid #0f172a; outline-offset: -3px; }
    .legend { font-size: 12px; gap: 12px; }
    .legend span { display: inline-flex; align-items: center; gap: 5px; }
    .swatch { width: 12px; height: 12px; border-radius: 2px; }
    .status { min-height: 26px; font-variant-numeric: tabular-nums; }
  </style>
</head>
<body>
<div id="root"></div>
<script type="module">
import { h, FunctionComponent, useState, useEffect, useMemo } from 'mini-react';

const ROWS = 12;
const COLS = 18;

function neighbors(cell) {
  const row = Math.floor(cell / COLS);
  const col = cell % COLS;
  return [[row - 1, col], [row, col + 1], [row + 1, col], [row, col - 1]]
    .filter(([r, c]) => r >= 0 && r < ROWS && c >= 0 && c < COLS)
    .map(([r, c]) => r * COLS + c);
}

// BFS calculates the trace once; playback only chooses how much to display.
function search(walls, start, end) {
  const queue = [start];
  const previous = new Map([[start, null]]);
  const discoveredAt = new Map([[start, 0]]);
  const order = [];
  for (let head = 0; head < queue.length; head++) {
    const cell = queue[head];
    order.push(cell);
    if (cell === end) break;
    for (const next of neighbors(cell)) {
      if (walls.has(next) || previous.has(next)) continue;
      previous.set(next, cell);
      discoveredAt.set(next, order.length);
      queue.push(next);
    }
  }
  const path = [];
  if (previous.has(end)) {
    for (let cell = end; cell !== null; cell = previous.get(cell)) path.unshift(cell);
  }
  return { order, discoveredAt, path };
}

function initialWalls() {
  const layout = [
    '##################',
    '#...#.#.....#...##',
    '###.#.#.#.#.#.#.##',
    '#.#.#...#.#.#.#.##',
    '#.#.#####.#.#.####',
    '#...#.....#.#...##',
    '#.###.#####.###.##',
    '#.#...#.....#...##',
    '#.###.#.#####.#.##',
    '#.....#.......#.##',
    '##################',
    '##################',
  ];
  return new Set(layout.flatMap((row, r) =>
    [...row].flatMap((cell, c) => cell === '#' ? [r * COLS + c] : [])));
}

// Children receive data and callbacks; only App owns state and Hooks.
function Toolbar({ tool, running, step, total, onTool, onPlay, onReplay, onClear }) {
  return h('div', { class: 'toolbar' },
    ...[['wall', '벽 그리기'], ['start', '출발점'], ['end', '도착점']].map(([value, label]) =>
      h('button', { type: 'button', 'data-tool': value, 'aria-pressed': String(tool === value), onClick: () => onTool(value) }, label)),
    h('button', { type: 'button', id: 'play', onClick: onPlay }, running ? '일시정지' : step >= total ? '다시 재생' : '재생'),
    h('button', { type: 'button', id: 'rewind', disabled: step === 0 && !running, onClick: onReplay }, '처음으로'),
    h('button', { type: 'button', id: 'clear', onClick: onClear }, '벽 지우기'),
  );
}

function Grid({ walls, start, end, visited, frontier, path, onPress, onEnter, onKeyboard }) {
  return h('div', { class: 'grid', role: 'group', 'aria-label': '길찾기 격자' },
    ...Array.from({ length: ROWS * COLS }, (_, cell) => {
      const kind = cell === start ? 'start' : cell === end ? 'end' : walls.has(cell) ? 'wall'
        : path.has(cell) ? 'path' : visited.has(cell) ? 'visited' : frontier.has(cell) ? 'frontier' : 'empty';
      const labels = { start: '출발', end: '도착', wall: '벽', path: '경로', visited: '탐색 완료', frontier: '탐색 대기', empty: '빈칸' };
      return h('button', {
        type: 'button', class: 'cell ' + kind, 'data-cell': cell,
        'aria-label': (Math.floor(cell / COLS) + 1) + '행 ' + (cell % COLS + 1) + '열 ' + labels[kind],
        onPointerDown: event => onPress(cell, event),
        onPointerEnter: event => onEnter(cell, event),
        onClick: event => { if (event.detail === 0) onKeyboard(cell); },
      }, cell === start ? 'S' : cell === end ? 'E' : '');
    }),
  );
}

function Legend() {
  return h('div', { class: 'legend' },
    ...[['#16a34a', '출발'], ['#e11d48', '도착'], ['#334155', '벽'], ['#bfdbfe', '탐색 완료'], ['#c4b5fd', '탐색 대기'], ['#facc15', '최단 경로']]
      .map(([color, label]) => h('span', {}, h('i', { class: 'swatch', style: 'background:' + color, 'aria-hidden': 'true' }), label)),
  );
}

function App() {
  const [walls, setWalls] = useState(initialWalls);
  const [start, setStart] = useState(5 * COLS + 2);
  const [end, setEnd] = useState(5 * COLS + 15);
  const [tool, setTool] = useState('wall');
  const [painting, setPainting] = useState(null);
  const [step, setStep] = useState(0);
  const [running, setRunning] = useState(false);

  // Animation changes step frequently, but the search inputs stay the same.
  const result = useMemo(() => search(walls, start, end), [walls, start, end]);
  const total = result.order.length + result.path.length;

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setStep(value => Math.min(value + 1, total)), 35);
    return () => window.clearInterval(timer);
  }, [running, total]);

  useEffect(() => {
    if (running && step >= total) setRunning(false);
  }, [running, step, total]);

  useEffect(() => {
    const release = () => setPainting(null);
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    window.addEventListener('blur', release);
    return () => {
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
      window.removeEventListener('blur', release);
    };
  }, []);

  function rewind() {
    setRunning(false);
    setStep(0);
  }

  function edit(cell, action) {
    if (cell === start || cell === end) return;
    rewind();
    if (tool === 'start' || tool === 'end') {
      (tool === 'start' ? setStart : setEnd)(cell);
      setWalls(previous => {
        if (!previous.has(cell)) return previous;
        const next = new Set(previous);
        next.delete(cell);
        return next;
      });
      return;
    }
    setWalls(previous => {
      const fill = action ?? !previous.has(cell);
      if (previous.has(cell) === fill) return previous;
      const next = new Set(previous);
      if (fill) next.add(cell); else next.delete(cell);
      return next;
    });
  }

  const visited = new Set(result.order.slice(0, step));
  const frontier = new Set([...result.discoveredAt]
    .filter(([cell, discovered]) => discovered <= step && !visited.has(cell))
    .map(([cell]) => cell));
  const path = new Set(result.path.slice(0, Math.max(0, step - result.order.length)));
  const complete = step >= total;
  const status = complete
    ? result.path.length ? '최단 거리 ' + (result.path.length - 1) + '칸 · 탐색 ' + result.order.length + '칸' : '도착점으로 가는 길이 없습니다.'
    : step === 0 ? '벽을 드래그하거나 출발점과 도착점을 옮겨 보세요.'
    : '탐색 ' + Math.min(step, result.order.length) + '칸' + (running ? '' : ' · 일시정지');

  return h('main', {},
    h('h1', {}, '길찾기'),
    h(Toolbar, {
      tool, running, step, total,
      onTool: value => { setTool(value); setPainting(null); },
      onPlay: () => { if (complete) setStep(0); setRunning(value => !value); },
      onReplay: rewind,
      onClear: () => { rewind(); setWalls(new Set()); },
    }),
    h(Grid, {
      walls, start, end, visited, frontier, path,
      onPress: (cell, event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const fill = !walls.has(cell);
        setPainting(tool === 'wall' ? fill : null);
        edit(cell, fill);
      },
      onEnter: (cell, event) => {
        if (painting !== null && (event.buttons & 1)) edit(cell, painting);
      },
      onKeyboard: cell => edit(cell),
    }),
    h(Legend),
    h('p', { class: 'status', role: 'status' }, status),
  );
}

new FunctionComponent(App, document.querySelector('#root')).mount();
</script>
</body>
</html>`;
