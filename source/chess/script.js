// all paths are relative to quinnsavitt.com
const MOVE_API  = '/chess/move';
const LEARN_API = '/chess/learn';

const game = new Chess();
const board = Chessboard('board', {
  draggable: true,
  position: 'start',
  onDrop: handlePlayerMove,
  moveSpeed:     300,
  snapbackSpeed: 200,
  snapSpeed:     150
});

function updateStatus() {
  let s = '';
  if (game.in_checkmate()) {
    s = game.turn() === 'w' ? 'Black wins!' : 'White wins!';
  } else if (game.in_draw()) {
    s = 'Draw!';
  } else {
    s = (game.turn() === 'w' ? 'White' : 'Black') + ' to move';
    if (game.in_check()) s += ' (in check)';
  }
  document.getElementById('status').textContent = s;
}

async function handlePlayerMove(source, target) {
  const move = game.move({ from: source, to: target, promotion: 'q' });
  if (!move) return 'snapback';

  board.position(game.fen());
  updateStatus();

  // ask the engine for its reply
  const res = await fetch(MOVE_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fen: game.fen() })
  });
  const { move: engineMove } = await res.json();

  game.move(engineMove);
  board.position(game.fen());
  updateStatus();

  // if game over, report result
  if (game.game_over()) await reportResult();
}

async function reportResult() {
  const result = game.in_checkmate()
    ? (game.turn() === 'b' ? 'win' : 'loss')
    : 'draw';
  await fetch(LEARN_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pgn: game.pgn(), result })
  });
}
