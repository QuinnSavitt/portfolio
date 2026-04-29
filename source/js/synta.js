// Synta: parses two formats and renders to canvas
(function(){
  const bracketInput = document.getElementById('bracketInput');
  const syntaInput = document.getElementById('syntaInput');
  const sytInput = document.getElementById('sytInput');
  // Autofill example bracketed tree for "This is a wug"
  bracketInput.value = '[S [NP This] [VP [V is] [NP [D a] [N wug]]]]';
  // Autofill matching .synta example for "This is a wug"
  syntaInput.value = [
    '* D This',
    '* V is',
    '* D a',
    '* N wug',
    '3|4 NP',
    '2|5 VP',
    '1|6 S',
  ].join('\n');
  const syntaHighlight = document.getElementById('syntaHighlight');
  const syntaGutter = document.getElementById('syntaGutter');
  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');
  const exportBtn = document.getElementById('exportPng');
  const testExportBtn = document.getElementById('testExportPng');
  const saveQ = document.getElementById('saveQ');
  const openQ = document.getElementById('openQ');
  const openQBtn = document.getElementById('openQBtn');
  const convertBtn = document.getElementById('convertBtn');
  const reloadBtn = document.getElementById('reloadBtn');
  const renderSytBtn = document.getElementById('renderSyt');
  const saveSytBtn = document.getElementById('saveSyt');
  const openSyt = document.getElementById('openSyt');
  const openSytBtn = document.getElementById('openSytBtn');
  const errorsEl = document.getElementById('errors');

  let mode = 'bracket';
  let activeTreeMode = 'bracket';
  let lastParseErrors = [];
  let activeSytSource = '';

  sytInput.value = [
    '# SYT style example',
    'Blue = (30, 144, 255)',
    'Green = (11, 107, 59)',
    'All.Visible = true',
    'Lines.Width = 1',
    'Arrows.Width = 1.2',
    'Tree.Alignment = "level"',
  ].join('\n');

  function setMode(newMode){
    mode = newMode;
    if(newMode === 'bracket' || newMode === 'synta') activeTreeMode = newMode;
    document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('active', x.dataset.mode===mode));
    document.getElementById('bracketPane').classList.toggle('hidden', mode!=='bracket');
    document.getElementById('syntaPane').classList.toggle('hidden', mode!=='synta');
    document.getElementById('sytPane').classList.toggle('hidden', mode!=='syt');
    convertBtn.style.display = mode === 'syt' ? 'none' : '';
    convertBtn.textContent = mode === 'bracket' ? 'Convert → .synta' : 'Convert → Bracketed';
  }

  // Tabs
  document.querySelectorAll('.tab').forEach(t=>t.addEventListener('click',()=>{
    setMode(t.dataset.mode);
    renderLive();
  }));

  // Basic helpers
  function clearCanvas(){ ctx.clearRect(0,0,canvas.width,canvas.height); }

  function measureTextWidth(text, font){
    ctx.save();
    ctx.font = font;
    const width = ctx.measureText(text || '').width;
    ctx.restore();
    return width;
  }

  function colorFromValue(v, fallback){
    if(v === null || v === undefined) return fallback;
    if(Array.isArray(v) && v.length >= 3){
      const r = Math.max(0, Math.min(255, Number(v[0]) || 0));
      const g = Math.max(0, Math.min(255, Number(v[1]) || 0));
      const b = Math.max(0, Math.min(255, Number(v[2]) || 0));
      return `rgb(${r}, ${g}, ${b})`;
    }
    return String(v);
  }

  function applyLayoutFromTreeSettings(root, treeSettings){
    const minH = Number(treeSettings.MinHorizontalSpacing);
    const maxH = Number(treeSettings.MaxHorizontalSpacing);
    const minV = Number(treeSettings.MinVerticalSpacing);
    const maxV = Number(treeSettings.MaxVerticalSpacing);
    const spacingX = Math.max(60, (isFinite(minH) ? minH : 120 + (isFinite(maxH) ? maxH : 120)) / 2);
    const spacingY = Math.max(90, (isFinite(minV) ? minV : 200 + (isFinite(maxV) ? maxV : 200)) / 2);
    layoutTopDownTree(root, 80, spacingX, spacingY, 90);

    if((treeSettings.Alignment || 'level') === 'bottom'){
      const leaves = [];
      function collectLeaves(node){
        if(node.children && node.children.length) node.children.forEach(collectLeaves);
        else leaves.push(node);
      }
      collectLeaves(root);
      const bottom = leaves.reduce((m,n)=>Math.max(m, n._y || 0), 0);
      leaves.forEach(n=>{ n._y = bottom; });
    }
  }

  function buildSceneFromRoot(root){
    const scene = {
      All: [],
      Nodes: [],
      Terms: [],
      Lines: [],
      Arrows: [],
      Tree: {
        Type: 'Tree',
        Id: 'Tree',
        Visible: true,
        Alignment: 'level',
        MinVerticalSpacing: 200,
        MaxVerticalSpacing: 200,
        MinHorizontalSpacing: 120,
        MaxHorizontalSpacing: 120,
      },
    };

    let nextId = 1;
    function enrich(node, parent){
      if(!node || node._sceneReady) return;
      node._sceneReady = true;
      node.Type = node.type === 'term' ? 'Term' : 'Node';
      node.Visible = node.Visible !== false;
      node.Id = node.Id || (`N${nextId++}`);
      node.Text = node.type === 'term' ? (node.word || node.label || '?') : (node.label || '?');
      node.Category = node.pos || node.label || null;
      node.TextSize = Number(node.TextSize) || 18;
      node.Color = node.Color || (node.type === 'term' ? '#1e90ff' : '#0b6b3b');
      node.Font = node.Font || 'Inter, "Segoe UI", Arial, sans-serif';
      node.Parent = parent || null;
      node.Children = (node.children || []);
      node.X = node._x;
      node.Y = node._y;
      scene.All.push(node);
      if(node.type === 'term') scene.Terms.push(node);
      scene.Nodes.push(node);
      (node.children || []).forEach(child=>enrich(child, node));
    }

    enrich(root, null);

    function collectLines(node){
      if(node.children && node.children.length){
        node.children.forEach(child=>{
          const line = {
            Type: 'Line',
            Id: `L${scene.Lines.length + 1}`,
            Visible: true,
            Parent: node,
            Child: child,
            Width: 0.8,
            Color: '#000000',
            Style: 'solid',
          };
          scene.Lines.push(line);
          scene.All.push(line);
          collectLines(child);
        });
      }
    }

    collectLines(root);
    return scene;
  }

  function runSyt(scene){
    if(!activeSytSource.trim()) return;
    if(!window.SYT || !window.SYT.run) return;
    window.SYT.run(activeSytSource, scene);
  }

  function isVisibleNode(node){
    return !!(node && ((node.type === 'term') || node.label || node.word || node.sub || node.pos || node.index));
  }

  function layoutTopDownTree(root, startX, spacingX, spacingY, yTop){
    let nextX = startX;
    function layout(node, depth){
      node._depth = depth;
      if(node.children && node.children.length){
        node.children.forEach(child=>layout(child, depth + 1));
        const xs = node.children.map(child=>child._x || 0);
        node._x = xs.reduce((a,b)=>a+b,0) / xs.length;
        node._y = yTop + depth * spacingY;
      } else {
        node._x = nextX;
        node._y = yTop + depth * spacingY;
        nextX += spacingX;
      }
    }
    layout(root, 0);
  }

  function withFitToCanvas(bounds, drawFn){
    clearCanvas();
    if(!bounds) return;
    const padding = 40;
    const width = Math.max(1, bounds.maxX - bounds.minX);
    const height = Math.max(1, bounds.maxY - bounds.minY);
    const scale = Math.min(1, (canvas.width - padding * 2) / width, (canvas.height - padding * 2) / height);
    const drawnWidth = width * scale;
    const drawnHeight = height * scale;
    const offsetX = (canvas.width - drawnWidth) / 2 - bounds.minX * scale;
    const offsetY = (canvas.height - drawnHeight) / 2 - bounds.minY * scale;
    ctx.save();
    ctx.setTransform(scale, 0, 0, scale, offsetX, offsetY);
    drawFn();
    ctx.restore();
  }

  function expandBounds(bounds, minX, minY, maxX, maxY){
    if(minX < bounds.minX) bounds.minX = minX;
    if(minY < bounds.minY) bounds.minY = minY;
    if(maxX > bounds.maxX) bounds.maxX = maxX;
    if(maxY > bounds.maxY) bounds.maxY = maxY;
  }

  function boundsForTreeNode(node){
    if(node.type === 'group' && !isVisibleNode(node)){
      return {minX: node._x, maxX: node._x, minY: node._y, maxY: node._y};
    }
    const label = node.type === 'term' && node.word ? node.word : (node.label || node.word || '?');
    const upper = node.type === 'term' ? (node.pos ? formatName(node.pos, node.posSub) : '') : '';
    const lower = node.type === 'term' ? (node.sub || '') : (node.sub || '');
    const indexText = node.index && !node.hideIndex ? `{${node.index}}` : '';
    const mainWidth = measureTextWidth(label, '700 18px Inter, "Segoe UI", Arial, sans-serif');
    const upperWidth = upper ? measureTextWidth(upper, '600 14px Inter, "Segoe UI", Arial, sans-serif') : 0;
    const lowerWidth = lower ? measureTextWidth(lower, '600 12px Inter, "Segoe UI", Arial, sans-serif') : 0;
    const indexWidth = indexText ? measureTextWidth(indexText, '10px sans-serif') : 0;
    const halfWidth = Math.max(mainWidth, upperWidth, lowerWidth, indexWidth) / 2 + 8;
    const topPad = node.type === 'term' ? (indexText ? 28 : 18) : (indexText ? 26 : 14);
    const bottomPad = node.type === 'term' ? (lower ? 28 : 16) : (lower ? 24 : 14);
    return {
      minX: node._x - halfWidth,
      maxX: node._x + halfWidth,
      minY: node._y - topPad,
      maxY: node._y + bottomPad,
    };
  }

  function boundsForGraphNode(node){
    if(node.type === 'group' && !isVisibleNode(node)){
      return {minX: node._x, maxX: node._x, minY: node._y, maxY: node._y};
    }
    const label = node.type === 'term' && node.word ? node.word : (node.label || node.word || '?');
    const upper = node.type === 'term' ? (node.pos ? formatName(node.pos, node.posSub) : '') : '';
    const lower = node.type === 'term' ? (node.sub || '') : (node.sub || '');
    const indexText = node.index && !node.hideIndex ? `{${node.index}}` : '';
    const mainWidth = measureTextWidth(label, '700 18px Inter, "Segoe UI", Arial, sans-serif');
    const upperWidth = upper ? measureTextWidth(upper, '600 14px Inter, "Segoe UI", Arial, sans-serif') : 0;
    const lowerWidth = lower ? measureTextWidth(lower, '600 12px Inter, "Segoe UI", Arial, sans-serif') : 0;
    const indexWidth = indexText ? measureTextWidth(indexText, '10px sans-serif') : 0;
    const halfWidth = Math.max(mainWidth, upperWidth, lowerWidth, indexWidth) / 2 + 8;
    const topPad = node.type === 'term' ? (indexText ? 28 : 18) : (indexText ? 26 : 14);
    const bottomPad = node.type === 'term' ? (lower ? 28 : 16) : (lower ? 24 : 14);
    return {
      minX: node._x - halfWidth,
      maxX: node._x + halfWidth,
      minY: node._y - topPad,
      maxY: node._y + bottomPad,
    };
  }

  // --- Bracketed parser (simplified but supports indices, *_hidden, _subtext, ->index arrows)
  function parseBracketed(text){
    // Parse bracketed notation such as [S [NP This] [VP [V is] [NP [D a] [N wug]]]]
    let i=0; const s=text;
    function skipWs(){ while(i<s.length && /\s/.test(s[i])) i++; }
    function readToken(){ skipWs(); let tok=''; while(i<s.length && !/\s|\[|\]|\(|\)/.test(s[i])) tok+=s[i++]; return tok; }

    function parseMarkedToken(tok){
      let sub=null; let index=null; let hideIndex=false; let arrowTo=null; let label = tok;
      const idxMatch = label.match(/(.*)\{(\*?\d+)\}$/);
      if(idxMatch){ label=idxMatch[1]; const raw=idxMatch[2]; if(raw.startsWith('*')){ hideIndex=true; index=raw.slice(1);} else index=raw; }
      const arrowMatch = label.match(/(.*)->(\d+)$/);
      if(arrowMatch){ label=arrowMatch[1]; arrowTo=arrowMatch[2]; }
      const subMatch = label.match(/(.*)_(.+)$/);
      if(subMatch){ label=subMatch[1]; sub=subMatch[2]; }
      return {label, sub, index, hideIndex, arrowTo};
    }

    function readParenPhrase(){
      // Parentheses represent a single multi-word terminal segment.
      i++; // consume '('
      let depth = 1;
      let phrase = '';
      while(i < s.length && depth > 0){
        const ch = s[i++];
        if(ch === '('){ depth++; phrase += ch; continue; }
        if(ch === ')'){
          depth--;
          if(depth === 0) break;
          phrase += ch;
          continue;
        }
        phrase += ch;
      }
      return phrase.trim();
    }

    function parseBracketNode(){ // when at '['
      i++; skipWs();
      const headTok = readToken();
      const head = parseMarkedToken(headTok || '');
      const node = {
        type:'node',
        label:head.label||'',
        sub:head.sub,
        index:head.index,
        hideIndex:head.hideIndex,
        arrowTo:head.arrowTo,
        children:[]
      };
      while(i<s.length){ skipWs(); if(s[i]===']'){ i++; break; }
        if(s[i]==='['){ node.children.push(parseBracketNode()); }
        else if(s[i]==='('){
          const phrase = readParenPhrase();
          if(phrase) node.children.push({type:'term', label:phrase, word:phrase, sub:null, index:null, hideIndex:false, arrowTo:null});
        }
        else {
          const tok = readToken(); if(tok) node.children.push(makeTokenNode(tok)); else { i++; }
        }
      }
      return node;
    }

    function parseParenGroup(){ // legacy path: keep as grouped phrase terminal
      const phrase = readParenPhrase();
      return {type:'term', label:phrase, word:phrase, sub:null, index:null, hideIndex:false, arrowTo:null};
    }

    function makeTokenNode(tok){ // handle index, subtext, arrow notation on single token
      const marked = parseMarkedToken(tok);
      // treat bare tokens as terminal words
      return {type:'term', label:marked.label, word:marked.label, sub:marked.sub, index:marked.index, hideIndex:marked.hideIndex, arrowTo:marked.arrowTo};
    }

    // allow multiple top-level items
    const items = [];
    try{
      while(i<s.length){ skipWs(); if(i>=s.length) break; if(s[i]==='['){ items.push(parseBracketNode()); }
        else if(s[i]==='('){ items.push(parseParenGroup()); }
        else { const tok = readToken(); if(tok) items.push(makeTokenNode(tok)); else i++; }
      }
      // if a single top-level item, return it as root, else wrap
      const root = items.length===1? items[0] : {type:'node', label:'a wug', children:items};
      return {root, errors:[]};
    }catch(e){ return {root:null, errors:[String(e)]}; }
  }

  // --- .synta parser
  function parseSynta(text, checkErrors=false){
    const lines = text.split(/\r?\n/);
    const nodesByLine = {};
    const arrows=[]; const errors=[];
    for(let li=0;li<lines.length;li++){
      const rawLine = lines[li]; const lineNum = li+1; const raw = rawLine.trim();
      if(raw==='') continue; // skip blank lines but numbering remains by position
      // Determine the explicit line number from the textarea position (1-based)
      const curNum = lineNum;
      // If user included a leading number in the content, strip it but still use curNum
      const maybeStrip = raw.match(/^\s*(\d+)\s+(.*)$/);
      const rest = maybeStrip ? maybeStrip[2].trim() : raw;
      if(nodesByLine[curNum] !== undefined){ errors.push(`Line ${lineNum}: duplicate line number ${curNum}`); continue; }
      // terminal: rest starts with *
      if(rest.startsWith('*')){
        const parts = rest.slice(1).trim().split(/\s+/);
        if(parts.length<2){ errors.push(`Line ${lineNum}: invalid terminal`); nodesByLine[curNum]=null; continue; }
        const posRaw = parts[0];
        const wordRaw = stripOuterParens(parts.slice(1).join(' '));
        const posParts = splitUnderscore(posRaw);
        const wordParts = splitUnderscore(wordRaw);
        nodesByLine[curNum] = {
          type:'term',
          label:posParts.label,
          pos:posParts.label,
          posSub:posParts.sub,
          word:wordParts.label,
          sub:wordParts.sub,
        };
        continue;
      }
      // arrow line like A->B {label} (rest contains the arrow spec)
      const arrowMatch = rest.match(/^(\d+)\s*->\s*(\d+)(?:\s*\{([^}]*)\})?$/);
      if(arrowMatch){ const a=Number(arrowMatch[1]); const b=Number(arrowMatch[2]);
        // references in arrow must refer to previously defined lines (by textarea line index)
        if(a>=curNum || b>=curNum || a===curNum || b===curNum){ errors.push(`Line ${lineNum}: arrow references must be to earlier lines`); }
        arrows.push({from:a,to:b,label:arrowMatch[3]||null}); nodesByLine[curNum]=null; continue; }
      // composition: refs then name
      const parts = rest.split(/\s+/);
      if(parts.length<2){ errors.push(`Line ${lineNum}: invalid definition`); nodesByLine[curNum]=null; continue; }
      const refsPart = parts[0];
      const name = parts.slice(1).join(' ');
      const refs = refsPart.split('|').map(x=>Number(x));
      // validate refs: must be numbers and point to earlier explicit lines (by textarea index)
      for(const r of refs){ if(!Number.isFinite(r) || r<1 || r>=curNum){ errors.push(`Line ${lineNum}: invalid reference ${r}`); } }
      const {label,sub} = splitUnderscore(name);
      nodesByLine[curNum] = {type:'node', label, sub, children:refs};
    }
    if(checkErrors){ return {nodesByLine,arrows,errors}; }
    return {nodesByLine,arrows,errors};
  }

  function splitUnderscore(s){ const m=s.match(/^(.*?)_(.+)$/); return m?{label:m[1],sub:m[2]}:{label:s,sub:null}; }

    function stripOuterParens(text){
      const t = String(text || '').trim();
      if(t.length >= 2 && t[0] === '(' && t[t.length - 1] === ')') return t.slice(1, -1).trim();
      return t;
    }

  function formatName(label, sub){
    const base = String(label || '').trim();
    const st = String(sub || '').trim();
    return st ? `${base}_${st}` : base;
  }

  function formatWord(word){
    const w = String(word || '').trim();
    return /\s/.test(w) ? `(${w})` : w;
  }

  function makeMarkedToken(base, index, arrow){
    let token = String(base || 'X');
    if(index !== null && index !== undefined) token += `{${index}}`;
    if(arrow !== null && arrow !== undefined) token += `->${arrow}`;
    return token;
  }

  function convertBracketToSynta(parsed){
    if(!parsed || !parsed.root) return '';
    const lines = [];
    const pendingArrows = [];
    const indexToLine = {};

    function registerIndex(idx, lineId){ if(idx!==null && idx!==undefined && idx!=='') indexToLine[String(idx)] = lineId; }
    function registerArrow(node, lineId){ if(node && node.arrowTo) pendingArrows.push({from: lineId, toIndex: String(node.arrowTo)}); }

    function emitNode(node){
      if(!node) return null;

      if(node.type === 'group'){
        const ids = [];
        (node.children || []).forEach(child=>{ const id = emitNode(child); if(id!==null) ids.push(id); });
        return ids.length ? ids[ids.length - 1] : null;
      }

      // Convert preterminal [POS word] into synta terminal "* POS word".
      if(node.type === 'node' && (node.children || []).length === 1 && node.children[0] && node.children[0].type === 'term'){
        const child = node.children[0];
        const pos = formatName(node.label, node.sub) || 'X';
        const word = formatWord(formatName(child.word || child.label, child.sub));
        lines.push(`* ${pos} ${word}`);
        const lineId = lines.length;
        registerIndex(node.index, lineId);
        registerIndex(child.index, lineId);
        registerArrow(node, lineId);
        registerArrow(child, lineId);
        return lineId;
      }

      if(node.type === 'term'){
        const word = formatWord(formatName(node.word || node.label, node.sub));
        lines.push(`* W ${word}`);
        const lineId = lines.length;
        registerIndex(node.index, lineId);
        registerArrow(node, lineId);
        return lineId;
      }

      const childIds = [];
      (node.children || []).forEach(child=>{
        if(child && child.type === 'group'){
          (child.children || []).forEach(gc=>{ const id = emitNode(gc); if(id!==null) childIds.push(id); });
        } else {
          const id = emitNode(child);
          if(id!==null) childIds.push(id);
        }
      });

      const name = formatName(node.label, node.sub) || 'X';
      if(childIds.length === 0){
        lines.push(`* X ${formatWord(name)}`);
      } else {
        lines.push(`${childIds.join('|')} ${name}`);
      }
      const lineId = lines.length;
      registerIndex(node.index, lineId);
      registerArrow(node, lineId);
      return lineId;
    }

    if(parsed.root.type === 'group'){
      (parsed.root.children || []).forEach(child=>emitNode(child));
    } else {
      emitNode(parsed.root);
    }

    // Keep only common arrow info (source/target). Bracket labels are not shared.
    pendingArrows.forEach(a=>{
      const to = indexToLine[a.toIndex];
      if(to && a.from && a.from !== to){
        lines.push(`${a.from}->${to}`);
      }
    });

    return lines.join('\n');
  }

  function convertSyntaToBracket(parsed){
    const nodes = parsed ? parsed.nodesByLine : null;
    if(!nodes) return '';

    const graph = {};
    const referenced = new Set();
    Object.keys(nodes).forEach(key=>{
      const value = nodes[key];
      if(!value) return;
      graph[key] = Object.assign({}, value, { id: Number(key), childIds: (value.children || []).slice(), children: [] });
      (value.children || []).forEach(childId => referenced.add(String(childId)));
    });

    function resolveNode(id, stack){
      const node = graph[id];
      if(!node || stack.has(id)) return null;
      if(node._resolved) return node;
      stack.add(id);
      node.children = node.childIds.map(childId => resolveNode(String(childId), stack)).filter(Boolean);
      node._resolved = true;
      stack.delete(id);
      return node;
    }

    const rootIds = Object.keys(graph).filter(id => !referenced.has(String(id)));
    const roots = rootIds.map(id => resolveNode(String(id), new Set())).filter(Boolean);

    // Preserve only shared arrow structure: drop synta arrow labels.
    const incomingIndexByNode = {};
    const outgoingIndexByNode = {};
    (parsed.arrows || []).forEach(a=>{
      const to = String(a.to);
      const from = String(a.from);
      if(!graph[from] || !graph[to]) return;
      const idx = Number(to);
      incomingIndexByNode[to] = idx;
      if(outgoingIndexByNode[from] === undefined) outgoingIndexByNode[from] = idx;
    });

    function serializeNode(node){
      if(!node) return '';
      const incoming = incomingIndexByNode[String(node.id)];
      const outgoing = outgoingIndexByNode[String(node.id)];

      if(node.type === 'term'){
        const posToken = makeMarkedToken(formatName(node.pos || node.label, node.posSub) || 'X', incoming, outgoing);
        const wordToken = formatWord(formatName(node.word, node.sub));
        return `[${posToken} ${wordToken}]`;
      }

      const baseName = formatName(node.label, node.sub) || 'X';
      const head = makeMarkedToken(baseName, incoming, outgoing);
      const children = (node.children || []).map(serializeNode).filter(Boolean);
      if(children.length === 0) return `[${head}]`;
      return `[${head} ${children.join(' ')}]`;
    }

    return roots.map(serializeNode).join('\n');
  }

  // --- Layout and render
  function renderFromBracket(parsed){
    if(!parsed || !parsed.root) return;
    // layout tree: position leaves left-to-right and parents above them
    layoutTopDownTree(parsed.root, 80, 120, 200, 90);

    const scene = buildSceneFromRoot(parsed.root);

    const indexMap = {};
    function buildIndex(node){ if(node.index) indexMap[String(node.index)] = node; if(node.children) node.children.forEach(buildIndex); }
    buildIndex(parsed.root);
    function collectArrows(node){
      if(node.arrowTo){
        const target = indexMap[String(node.arrowTo)];
        if(target){
          const arrow = {
            Type:'Arrow',
            Id:`A${scene.Arrows.length + 1}`,
            Visible:true,
            From:node,
            To:target,
            Width:1.1,
            Color:'#d93025',
            Style:'solid',
            Ends:'single',
            Label:null,
          };
          scene.Arrows.push(arrow);
          scene.All.push(arrow);
        }
      }
      if(node.children) node.children.forEach(collectArrows);
    }
    collectArrows(parsed.root);

    try {
      runSyt(scene);
      applyLayoutFromTreeSettings(parsed.root, scene.Tree);
      scene.Nodes.forEach(n=>{ n.X = n._x; n.Y = n._y; });
    } catch(e){
      errorsEl.classList.remove('hidden');
      errorsEl.textContent = e && e.message ? e.message : String(e);
      return;
    }

    const bounds = {minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity};
    function collectBounds(node){
      const nodeBounds = boundsForTreeNode(node);
      expandBounds(bounds, nodeBounds.minX, nodeBounds.minY, nodeBounds.maxX, nodeBounds.maxY);
      if(node.children) node.children.forEach(collectBounds);
    }
    collectBounds(parsed.root);
    bounds.minX -= 24;
    bounds.maxX += 24;
    bounds.minY -= 24;
    bounds.maxY += 24;
    
    scene.Arrows.forEach(arrow=>{
      const from = arrow.From;
      const to = arrow.To;
      const g = getArrowGeometry(
        from._x,
        from._y,
        to._x,
        to._y,
        {
          startLift: from.type === 'term' ? 34 : 20,
          endLift: to.type === 'term' ? 34 : 20,
          sceneTop: bounds.minY,
        }
      );
      expandBounds(bounds, Math.min(g.startX, g.endX, g.cx), Math.min(g.startY, g.endY, g.cy), Math.max(g.startX, g.endX, g.cx), Math.max(g.startY, g.endY, g.cy));
    });

    withFitToCanvas(bounds, ()=>{
      // draw edges parent -> child
      function drawEdges(node){
        if(node.children && node.children.length){
          node.children.forEach(c=>{
            const parentExit = (node.sub && node.type !== 'term') ? 34 : 18;
            const childEntry = c.type === 'term' ? 38 : 18;
            if(node._x && c._x){
              const lineStyle = scene.Lines.find(l=>l.Parent===node && l.Child===c && l.Visible!==false);
              if(!lineStyle || lineStyle.Visible!==false) drawLine(node._x,node._y + parentExit,c._x,c._y-childEntry,lineStyle);
            }
            drawEdges(c);
          });
        }
      }
      drawEdges(parsed.root);

      // draw nodes (post-order to ensure edges under nodes)
      function drawAll(node){
        if(node.children) node.children.forEach(drawAll);
        if(isVisibleNode(node) && node.Visible !== false) drawNode(node);
      }
      drawAll(parsed.root);

      scene.Arrows.forEach(arrow=>{
        if(arrow.Visible === false) return;
        const from = arrow.From;
        const to = arrow.To;
        drawArrow(from._x, from._y, to._x, to._y, arrow.Label, {
          startLift: from.type === 'term' ? 34 : 20,
          endLift: to.type === 'term' ? 34 : 20,
          sceneTop: bounds.minY,
        }, arrow);
      });
    });
  }

  function drawLine(x1,y1,x2,y2,lineStyle){
    const width = lineStyle && lineStyle.Width !== undefined ? Number(lineStyle.Width) : 0.8;
    const color = colorFromValue(lineStyle && lineStyle.Color, '#000000');
    const style = (lineStyle && lineStyle.Style) || 'solid';
    ctx.strokeStyle = color;
    ctx.lineWidth = isFinite(width) ? width : 0.8;
    ctx.lineCap = 'round';
    if(style === 'dashed') ctx.setLineDash([6,4]);
    else if(style === 'dotted') ctx.setLineDash([1.5,3]);
    else ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(x1,y1);
    ctx.lineTo(x2,y2);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  function getArrowGeometry(x1, y1, x2, y2, opts){
    const options = opts || {};
    const startLift = options.startLift || 18;
    const endLift = options.endLift || 18;
    const startX = x1;
    const startY = y1 - startLift;
    const endX = x2;
    const endY = y2 - endLift;
    const spanX = Math.abs(endX - startX);
    const cx = (startX + endX) / 2;
    const baseTop = Math.min(startY, endY);
    const archHeight = Math.max(110, 0.45 * spanX);
    const suggestedCy = baseTop - archHeight;
    const sceneTop = Number.isFinite(options.sceneTop) ? options.sceneTop : (baseTop - 80);
    const cy = Math.min(suggestedCy, sceneTop - 48);
    return { startX, startY, endX, endY, cx, cy };
  }

  function drawArrow(x1,y1,x2,y2,label,opts,arrowStyle){
    const g = getArrowGeometry(x1, y1, x2, y2, opts);

    const width = arrowStyle && arrowStyle.Width !== undefined ? Number(arrowStyle.Width) : 1.1;
    const color = colorFromValue(arrowStyle && arrowStyle.Color, '#d93025');
    const style = (arrowStyle && arrowStyle.Style) || 'solid';
    ctx.strokeStyle=color;
    ctx.fillStyle=color;
    ctx.lineWidth=isFinite(width) ? width : 1.1;
    ctx.lineCap='round';
    if(style === 'dashed') ctx.setLineDash([6,4]);
    else if(style === 'dotted') ctx.setLineDash([1.5,3]);
    else ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(g.startX,g.startY);
    ctx.quadraticCurveTo(g.cx,g.cy,g.endX,g.endY);
    ctx.stroke();
    ctx.setLineDash([]);

    if(label){
      // Label on the tangent at midpoint with line erased behind it.
      const t = 0.5;
      const mt = 1 - t;
      const mx = mt*mt*g.startX + 2*mt*t*g.cx + t*t*g.endX;
      const my = mt*mt*g.startY + 2*mt*t*g.cy + t*t*g.endY;
      const dx = 2*mt*(g.cx-g.startX) + 2*t*(g.endX-g.cx);
      const dy = 2*mt*(g.cy-g.startY) + 2*t*(g.endY-g.cy);
      let angle = Math.atan2(dy, dx);
      // Keep label readable: choose the tangent direction closer to upright.
      if(angle > Math.PI / 2) angle -= Math.PI;
      if(angle < -Math.PI / 2) angle += Math.PI;
      const text = String(label);
      ctx.save();
      ctx.font = '600 12px Inter, "Segoe UI", Arial, sans-serif';
      const textWidth = ctx.measureText(text).width;

      // Remove the stroke segment hidden by the label.
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = 'rgba(0,0,0,1)';
      ctx.lineWidth = 10;
      ctx.translate(mx, my);
      ctx.rotate(angle);
      ctx.beginPath();
      ctx.moveTo(-textWidth * 0.6, 0);
      ctx.lineTo(textWidth * 0.6, 0);
      ctx.stroke();
      ctx.restore();

      // Draw label above the curve following the tangent.
      ctx.save();
      ctx.translate(mx, my);
      ctx.rotate(angle);
      ctx.font = '600 12px Inter, "Segoe UI", Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = color;
      ctx.fillText(text, 0, -2);
      ctx.restore();
    }
  }
  function drawNode(n){
    const x = n._x || 100;
    const y = n._y || 100;
    const isTerm = n.type === 'term' || (!(n.children && n.children.length));
    const termColor = colorFromValue(n.Color, '#1e90ff');
    const nodeColor = colorFromValue(n.Color, '#0b6b3b');
    const subColor = colorFromValue(n.SubColor || n.Color, '#1e90ff');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Bold, larger labels for readability
    const fontSize = Number(n.TextSize) || 18;
    const fontFamily = n.Font || 'Inter, "Segoe UI", Arial, sans-serif';
    ctx.font = `700 ${fontSize}px ${fontFamily}`;
    ctx.fillStyle = isTerm ? termColor : nodeColor;
    const labelText = n.Text || (n.type === 'term' && n.word ? n.word : (n.label || n.word || '?'));
    const upperText = n.type === 'term' ? (n.pos ? formatName(n.pos, n.posSub) : '') : '';
    const lowerText = n.type === 'term' ? (n.sub || '') : (n.sub || '');
    if (n.type === 'term' && upperText) {
      ctx.fillStyle = subColor;
      ctx.font = `600 ${Math.max(11, fontSize - 4)}px ${fontFamily}`;
      ctx.fillText(upperText, x, y - 20);
      ctx.font = `700 ${fontSize}px ${fontFamily}`;
      ctx.fillStyle = termColor;
    }
    ctx.fillText(labelText, x, y);
    if (n.type === 'term' && lowerText) {
      ctx.fillStyle = subColor;
      ctx.font = `600 ${Math.max(10, fontSize - 6)}px ${fontFamily}`;
      ctx.fillText(lowerText, x, y + 18);
    }
    if (lowerText && n.type !== 'term') {
      ctx.fillStyle = subColor;
      ctx.font = `600 ${Math.max(11, fontSize - 4)}px ${fontFamily}`;
      ctx.fillText(lowerText, x, y + 20);
    }
    if (n.index && !n.hideIndex) {
      ctx.fillStyle = '#000';
      ctx.font = '10px sans-serif';
      ctx.fillText('{' + n.index + '}', x, y - 22);
    }
  }

  // Synta render: build graph, compute levels then draw
  function renderFromSynta(parsed){
    const nodes = parsed.nodesByLine;
    const arrows = parsed.arrows;
    const graph = {};
    const referenced = new Set();
    Object.keys(nodes).forEach(key=>{
      const value = nodes[key];
      if(!value) return;
      graph[key] = Object.assign({}, value, { id: Number(key), childIds: (value.children || []).slice(), children: [] });
      graph[key].children = graph[key].childIds.map(childId => null);
      (value.children || []).forEach(childId => referenced.add(String(childId)));
    });

    function resolveNode(id, stack){
      const node = graph[id];
      if(!node || stack.has(id)) return null;
      if(node._resolved) return node;
      stack.add(id);
      node.children = node.childIds.map(childId => resolveNode(String(childId), stack)).filter(Boolean);
      node._resolved = true;
      stack.delete(id);
      return node;
    }

    const rootIds = Object.keys(graph).filter(id => !referenced.has(String(id)));
    const roots = rootIds.map(id => resolveNode(String(id), new Set())).filter(Boolean);
    const root = roots.length === 1 ? roots[0] : { type:'group', children: roots };

    layoutTopDownTree(root, 80, 120, 200, 90);

    const scene = buildSceneFromRoot(root);
    arrows.forEach(a=>{
      const from = graph[String(a.from)];
      const to = graph[String(a.to)];
      if(!from || !to) return;
      const arrow = {
        Type:'Arrow',
        Id:`A${scene.Arrows.length + 1}`,
        Visible:true,
        From:from,
        To:to,
        Width:1.1,
        Color:'#d93025',
        Style:'solid',
        Ends:'single',
        Label:a.label || null,
      };
      scene.Arrows.push(arrow);
      scene.All.push(arrow);
    });

    try {
      runSyt(scene);
      applyLayoutFromTreeSettings(root, scene.Tree);
      scene.Nodes.forEach(n=>{ n.X = n._x; n.Y = n._y; });
    } catch(e){
      errorsEl.classList.remove('hidden');
      errorsEl.textContent = e && e.message ? e.message : String(e);
      return;
    }

    const bounds = {minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity};
    function collectBounds(node){
      const nodeBounds = boundsForGraphNode(node);
      expandBounds(bounds, nodeBounds.minX, nodeBounds.minY, nodeBounds.maxX, nodeBounds.maxY);
      if(node.children) node.children.forEach(collectBounds);
    }
    collectBounds(root);

    scene.Arrows.forEach(arrow=>{
      const from = arrow.From;
      const to = arrow.To;
      const g = getArrowGeometry(from._x, from._y, to._x, to._y, {
        startLift: from.type === 'term' ? 34 : 20,
        endLift: to.type === 'term' ? 34 : 20,
        sceneTop: bounds.minY,
      });
      expandBounds(bounds, Math.min(g.startX, g.endX, g.cx), Math.min(g.startY, g.endY, g.cy), Math.max(g.startX, g.endX, g.cx), Math.max(g.startY, g.endY, g.cy));
    });

    bounds.minX -= 24;
    bounds.maxX += 24;
    bounds.minY -= 24;
    bounds.maxY += 24;

    withFitToCanvas(bounds, ()=>{
      function drawEdges(node){
        if(node.children && node.children.length){
          node.children.forEach(child=>{
            const parentExit = (node.sub && node.type !== 'term') ? 34 : 18;
            const childEntry = child.type === 'term' ? 38 : 18;
            if(node._x && child._x){
              const lineStyle = scene.Lines.find(l=>l.Parent===node && l.Child===child && l.Visible!==false);
              if(!lineStyle || lineStyle.Visible!==false) drawLine(node._x, node._y + parentExit, child._x, child._y - childEntry, lineStyle);
            }
            drawEdges(child);
          });
        }
      }
      drawEdges(root);

      function drawAll(node){
        if(node.children) node.children.forEach(drawAll);
        if(isVisibleNode(node) && node.Visible !== false) drawNode(node);
      }
      drawAll(root);

      scene.Arrows.forEach(arrow=>{
        if(arrow.Visible === false) return;
        const from = arrow.From;
        const to = arrow.To;
        if(from && to) drawArrow(from._x, from._y, to._x, to._y, arrow.Label, {
          startLift: from.type === 'term' ? 34 : 20,
          endLift: to.type === 'term' ? 34 : 20,
          sceneTop: bounds.minY,
        }, arrow);
      });
    });
  }

  // live update
  function renderLive(){
    errorsEl.classList.add('hidden'); lastParseErrors=[];
    const treeMode = mode === 'syt' ? activeTreeMode : mode;
    if(treeMode==='bracket'){
      const parsed = parseBracketed(bracketInput.value);
      renderFromBracket(parsed);
    } else {
      const parsed = parseSynta(syntaInput.value,false);
      // update highlight
      highlightSynta();
      renderFromSynta(parsed);
    }
  }

  // highlight synta
  function highlightSynta(){
    // Native textarea cannot style tokens inline; keep this disabled to avoid overlay artifacts.
    syntaHighlight.textContent = '';
  }

  function updateGutter(){ const lines = syntaInput.value.split(/\n/); const nums = lines.map((l,i)=>String(i+1)); syntaGutter.innerText = nums.join('\n'); }

  // buttons
  function toBlobPromise(c){ return new Promise(resolve=>{ try{ c.toBlob(resolve,'image/png'); }catch(e){ resolve(null); } }); }

  async function exportCanvasAsPng(){
    try{
      // Ensure latest rendering (SYT or tree) has run
      try{ renderLive(); }catch(_){}
      await new Promise(r=>setTimeout(r,60));
      const blob = await toBlobPromise(canvas);
      if(!blob){ errorsEl.classList.remove('hidden'); errorsEl.textContent = 'Export failed: could not produce PNG blob.'; return; }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = 'tree.png'; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(()=>URL.revokeObjectURL(url), 1500);
    }catch(err){ errorsEl.classList.remove('hidden'); errorsEl.textContent = err && err.message ? err.message : String(err); }
  }

  exportBtn.addEventListener('click',()=>exportCanvasAsPng());

  async function runExportTest(){
    const originalMode = mode;
    const originalBracket = bracketInput.value;
    const originalSynta = syntaInput.value;
    const originalSyt = sytInput.value;
    try{
      errorsEl.classList.add('hidden');
      // Test bracketed path
      setMode('bracket');
      bracketInput.value = '[S [NP This] [VP [V is] [NP [D a] [N wug]]]]';
      renderLive();
      await new Promise(r=>setTimeout(r,80));
      const blob1 = await toBlobPromise(canvas);
      if(!blob1 || blob1.size < 2000) throw new Error('Bracketed export failed or produced small PNG (' + (blob1?blob1.size:0) + ' bytes)');

      // Test synta path
      setMode('synta');
      syntaInput.value = '* D This\n* V is\n* D a\n* N wug\n3|4 NP\n2|5 VP\n1|6 S';
      renderLive();
      await new Promise(r=>setTimeout(r,80));
      const blob2 = await toBlobPromise(canvas);
      if(!blob2 || blob2.size < 2000) throw new Error('Synta export failed or produced small PNG (' + (blob2?blob2.size:0) + ' bytes)');

      errorsEl.classList.remove('hidden');
      errorsEl.textContent = 'Export test passed: bracketed and .synta rendered and exported as PNG.';
    }catch(e){ errorsEl.classList.remove('hidden'); errorsEl.textContent = 'Export test FAILED: ' + (e && e.message ? e.message : String(e)); }
    finally{
      // restore
      bracketInput.value = originalBracket;
      syntaInput.value = originalSynta;
      sytInput.value = originalSyt;
      setMode(originalMode);
      renderLive();
    }
  }

  if(testExportBtn) testExportBtn.addEventListener('click',()=>{ runExportTest(); });
  saveQ.addEventListener('click',()=>{ const blob=new Blob([syntaInput.value],{type:'text/plain'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='tree.synta'; a.click(); });
  openQBtn.addEventListener('click',()=>openQ.click());
  openQ.addEventListener('change',e=>{ const f=e.target.files[0]; if(!f) return; const rdr=new FileReader(); rdr.onload=e=>{ syntaInput.value = e.target.result; highlightSynta(); renderLive(); }; rdr.readAsText(f); });
  saveSytBtn.addEventListener('click',()=>{ const blob=new Blob([sytInput.value],{type:'text/plain'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='style.syt'; a.click(); });
  openSytBtn.addEventListener('click',()=>openSyt.click());
  openSyt.addEventListener('change',e=>{ const f=e.target.files[0]; if(!f) return; const rdr=new FileReader(); rdr.onload=e=>{ sytInput.value = e.target.result; }; rdr.readAsText(f); });
  renderSytBtn.addEventListener('click',()=>{
    activeSytSource = sytInput.value;
    try {
      renderLive();
    } catch(err){
      errorsEl.classList.remove('hidden');
      errorsEl.textContent = err && err.message ? err.message : String(err);
    }
  });
  convertBtn.addEventListener('click',()=>{
    if(mode === 'bracket'){
      const parsed = parseBracketed(bracketInput.value);
      const out = convertBracketToSynta(parsed);
      syntaInput.value = out;
      highlightSynta();
      updateGutter();
      setMode('synta');
      renderLive();
      return;
    }

    const parsed = parseSynta(syntaInput.value,false);
    const out = convertSyntaToBracket(parsed);
    bracketInput.value = out;
    setMode('bracket');
    renderLive();
  });

  reloadBtn.addEventListener('click',()=>{
    lastParseErrors = [];
    const treeMode = mode === 'syt' ? activeTreeMode : mode;
    if(treeMode==='synta'){
      const parsed = parseSynta(syntaInput.value,true);
      lastParseErrors = parsed.errors;
    } else {
      // naive bracket validation
      try{ parseBracketed(bracketInput.value); }catch(e){ lastParseErrors=[String(e)]; }
    }
    if(lastParseErrors.length){ errorsEl.classList.remove('hidden'); errorsEl.textContent = lastParseErrors.join('\n'); } else { errorsEl.classList.add('hidden'); }
  });

  // events
  bracketInput.addEventListener('input',()=>renderLive());
  syntaInput.addEventListener('input',()=>{ highlightSynta(); updateGutter(); renderLive(); });
  syntaInput.addEventListener('scroll',()=>{ syntaGutter.scrollTop = syntaInput.scrollTop; });

  // init
  setMode('bracket');
  highlightSynta();
  updateGutter();
  renderLive();

})();
