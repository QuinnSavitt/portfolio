(function(){
  function SytError(message, token){
    this.name = 'SytError';
    this.message = message;
    this.token = token || null;
  }
  SytError.prototype = Object.create(Error.prototype);

  const KEYWORDS = new Set([
    'If','Elif','Else','While','For','each','Repeat','times','Func',
    'return','break','continue','pass',
    'and','or','not','in','has','where',
    'true','false','null'
  ]);

  const ASSIGN_OPS = new Set(['=','+=','-=','*=','/=','%=']);

  function tokenize(source){
    const tokens = [];
    const indentStack = [0];
    const lines = String(source || '').replace(/\r\n?/g, '\n').split('\n');

    for(let lineNo=0; lineNo<lines.length; lineNo++){
      let raw = lines[lineNo];
      const commentIdx = raw.indexOf('#');
      if(commentIdx >= 0) raw = raw.slice(0, commentIdx);
      const indentMatch = raw.match(/^\s*/);
      const indentText = indentMatch ? indentMatch[0] : '';
      const content = raw.slice(indentText.length);

      if(!content.trim()){
        tokens.push({type:'NEWLINE', value:'\n', line:lineNo+1, col:1});
        continue;
      }

      const indent = indentText.replace(/\t/g, '    ').length;
      const currentIndent = indentStack[indentStack.length - 1];
      if(indent > currentIndent){
        indentStack.push(indent);
        tokens.push({type:'INDENT', value:'INDENT', line:lineNo+1, col:1});
      } else if(indent < currentIndent){
        while(indent < indentStack[indentStack.length - 1]){
          indentStack.pop();
          tokens.push({type:'DEDENT', value:'DEDENT', line:lineNo+1, col:1});
        }
        if(indent !== indentStack[indentStack.length - 1]){
          throw new SytError('Inconsistent indentation at line ' + (lineNo + 1));
        }
      }

      let i = 0;
      while(i < content.length){
        const ch = content[i];
        const col = indent + i + 1;

        if(/\s/.test(ch)){ i++; continue; }

        const two = content.slice(i, i+2);
        const three = content.slice(i, i+3);

        if(three === '**='){
          tokens.push({type:'OP', value:'**=', line:lineNo+1, col});
          i += 3;
          continue;
        }

        if(['==','!=','<=','>=','+=','-=','*=','/=','%=','**'].includes(two)){
          tokens.push({type:'OP', value:two, line:lineNo+1, col});
          i += 2;
          continue;
        }

        if('=+-*/%()[]:,.<>'.includes(ch)){
          tokens.push({type:'OP', value:ch, line:lineNo+1, col});
          i++;
          continue;
        }

        if(ch === '"'){
          let j = i + 1;
          let str = '';
          while(j < content.length && content[j] !== '"'){
            if(content[j] === '\\' && j + 1 < content.length){
              const next = content[j+1];
              const map = {n:'\n', t:'\t', '"':'"', '\\':'\\'};
              str += map[next] !== undefined ? map[next] : next;
              j += 2;
            } else {
              str += content[j++];
            }
          }
          if(j >= content.length) throw new SytError('Unterminated string at line ' + (lineNo + 1));
          tokens.push({type:'STRING', value:str, line:lineNo+1, col});
          i = j + 1;
          continue;
        }

        if(/[0-9]/.test(ch)){
          let j = i;
          while(j < content.length && /[0-9]/.test(content[j])) j++;
          if(content[j] === '.'){
            j++;
            while(j < content.length && /[0-9]/.test(content[j])) j++;
          }
          tokens.push({type:'NUMBER', value:content.slice(i,j), line:lineNo+1, col});
          i = j;
          continue;
        }

        if(/[A-Za-z_]/.test(ch)){
          let j = i;
          while(j < content.length && /[A-Za-z0-9_]/.test(content[j])) j++;
          const value = content.slice(i,j);
          tokens.push({type: KEYWORDS.has(value) ? 'KW' : 'IDENT', value, line:lineNo+1, col});
          i = j;
          continue;
        }

        throw new SytError('Unexpected character "' + ch + '" at line ' + (lineNo + 1));
      }

      tokens.push({type:'NEWLINE', value:'\n', line:lineNo+1, col:content.length+1});
    }

    while(indentStack.length > 1){
      indentStack.pop();
      tokens.push({type:'DEDENT', value:'DEDENT', line:lines.length, col:1});
    }

    tokens.push({type:'EOF', value:'EOF', line:lines.length + 1, col:1});
    return tokens;
  }

  function Parser(tokens){
    this.tokens = tokens;
    this.pos = 0;
  }

  Parser.prototype.peek = function(offset){
    return this.tokens[this.pos + (offset || 0)] || this.tokens[this.tokens.length - 1];
  };

  Parser.prototype.advance = function(){
    const t = this.peek(0);
    this.pos++;
    return t;
  };

  Parser.prototype.match = function(type, value){
    const t = this.peek(0);
    if(!t) return false;
    if(type && t.type !== type) return false;
    if(value !== undefined && t.value !== value) return false;
    this.pos++;
    return true;
  };

  Parser.prototype.expect = function(type, value, msg){
    const t = this.peek(0);
    if(this.match(type, value)) return t;
    throw new SytError(msg || ('Expected ' + (value || type)), t);
  };

  Parser.prototype.skipNewlines = function(){
    while(this.match('NEWLINE')){}
  };

  Parser.prototype.parseProgram = function(){
    const body = [];
    this.skipNewlines();
    while(this.peek().type !== 'EOF'){
      const stmt = this.parseStatement();
      body.push(stmt);
      this.skipNewlines();
    }
    return {type:'Program', body};
  };

  Parser.prototype.parseStatement = function(){
    const t = this.peek();
    if(t.type === 'KW'){
      if(t.value === 'If') return this.parseIfStmt();
      if(t.value === 'While') return this.parseWhileStmt();
      if(t.value === 'For') return this.parseForStmt();
      if(t.value === 'Repeat') return this.parseRepeatStmt();
      if(t.value === 'Func') return this.parseFuncDef();
      if(t.value === 'return') return this.parseReturnStmt();
      if(t.value === 'break') { this.advance(); return {type:'BreakStmt'}; }
      if(t.value === 'continue') { this.advance(); return {type:'ContinueStmt'}; }
      if(t.value === 'pass') { this.advance(); return {type:'PassStmt'}; }
    }

    const expr = this.parseExpression();
    const op = this.peek();
    if(op.type === 'OP' && ASSIGN_OPS.has(op.value)){
      this.advance();
      const value = this.parseExpression();
      return {type:'Assign', target:expr, op:op.value, value};
    }
    return {type:'ExprStmt', expr};
  };

  Parser.prototype.parseBlock = function(){
    this.expect('NEWLINE', undefined, 'Expected newline before block');
    this.expect('INDENT', 'INDENT', 'Expected indent');
    const body = [];
    this.skipNewlines();
    while(this.peek().type !== 'DEDENT' && this.peek().type !== 'EOF'){
      body.push(this.parseStatement());
      this.skipNewlines();
    }
    this.expect('DEDENT', 'DEDENT', 'Expected dedent');
    return body;
  };

  Parser.prototype.parseIfStmt = function(){
    this.expect('KW', 'If');
    const test = this.parseExpression();
    this.expect('OP', ':');
    const consequent = this.parseBlock();
    const elifs = [];
    while(this.peek().type === 'KW' && this.peek().value === 'Elif'){
      this.advance();
      const eTest = this.parseExpression();
      this.expect('OP', ':');
      const eBody = this.parseBlock();
      elifs.push({test:eTest, body:eBody});
    }
    let alternate = null;
    if(this.peek().type === 'KW' && this.peek().value === 'Else'){
      this.advance();
      this.expect('OP', ':');
      alternate = this.parseBlock();
    }
    return {type:'IfStmt', test, consequent, elifs, alternate};
  };

  Parser.prototype.parseWhileStmt = function(){
    this.expect('KW','While');
    const test = this.parseExpression();
    this.expect('OP',':');
    const body = this.parseBlock();
    return {type:'WhileStmt', test, body};
  };

  Parser.prototype.parseForStmt = function(){
    this.expect('KW','For');
    this.expect('KW','each');
    const iterVar = this.expect('IDENT').value;
    this.expect('KW','in');
    const iterable = this.parseExpression();
    this.expect('OP',':');
    const body = this.parseBlock();
    return {type:'ForEachStmt', iterVar, iterable, body};
  };

  Parser.prototype.parseRepeatStmt = function(){
    this.expect('KW','Repeat');
    const countExpr = this.parseExpression();
    this.expect('KW','times');
    this.expect('OP',':');
    const body = this.parseBlock();
    return {type:'RepeatStmt', countExpr, body};
  };

  Parser.prototype.parseFuncDef = function(){
    this.expect('KW','Func');
    const name = this.expect('IDENT').value;
    this.expect('OP','(');
    const params = [];
    if(!this.match('OP',')')){
      do {
        params.push(this.expect('IDENT').value);
      } while(this.match('OP',','));
      this.expect('OP',')');
    }
    this.expect('OP',':');
    const body = this.parseBlock();
    return {type:'FuncDef', name, params, body};
  };

  Parser.prototype.parseReturnStmt = function(){
    this.expect('KW','return');
    if(this.peek().type === 'NEWLINE' || this.peek().type === 'DEDENT' || this.peek().type === 'EOF'){
      return {type:'ReturnStmt', value:null};
    }
    return {type:'ReturnStmt', value:this.parseExpression()};
  };

  Parser.prototype.parseExpression = function(){
    return this.parseOr();
  };

  Parser.prototype.parseOr = function(){
    let expr = this.parseAnd();
    while(this.peek().type === 'KW' && this.peek().value === 'or'){
      const op = this.advance().value;
      const right = this.parseAnd();
      expr = {type:'BinaryOp', op, left:expr, right};
    }
    return expr;
  };

  Parser.prototype.parseAnd = function(){
    let expr = this.parseNot();
    while(this.peek().type === 'KW' && this.peek().value === 'and'){
      const op = this.advance().value;
      const right = this.parseNot();
      expr = {type:'BinaryOp', op, left:expr, right};
    }
    return expr;
  };

  Parser.prototype.parseNot = function(){
    if(this.peek().type === 'KW' && this.peek().value === 'not'){
      this.advance();
      const arg = this.parseNot();
      return {type:'UnaryOp', op:'not', argument:arg};
    }
    return this.parseComparison();
  };

  Parser.prototype.parseComparison = function(){
    let expr = this.parseAdditive();
    while(true){
      const t = this.peek();
      if(t.type === 'OP' && ['==','!=','<','<=','>','>='].includes(t.value)){
        const op = this.advance().value;
        const right = this.parseAdditive();
        expr = {type:'BinaryOp', op, left:expr, right};
        continue;
      }
      if(t.type === 'KW' && t.value === 'in'){
        this.advance();
        const right = this.parseAdditive();
        expr = {type:'BinaryOp', op:'in', left:expr, right};
        continue;
      }
      if(t.type === 'KW' && t.value === 'has'){
        this.advance();
        const rhs = this.peek().type === 'IDENT' ? {type:'Identifier', name:this.advance().value} : this.parseAdditive();
        expr = {type:'BinaryOp', op:'has', left:expr, right:rhs};
        continue;
      }
      if(t.type === 'KW' && t.value === 'not' && this.peek(1).type === 'KW' && this.peek(1).value === 'in'){
        this.advance();
        this.advance();
        const right = this.parseAdditive();
        expr = {type:'BinaryOp', op:'not in', left:expr, right};
        continue;
      }
      break;
    }
    return expr;
  };

  Parser.prototype.parseAdditive = function(){
    let expr = this.parseMultiplicative();
    while(this.peek().type === 'OP' && (this.peek().value === '+' || this.peek().value === '-')){
      const op = this.advance().value;
      const right = this.parseMultiplicative();
      expr = {type:'BinaryOp', op, left:expr, right};
    }
    return expr;
  };

  Parser.prototype.parseMultiplicative = function(){
    let expr = this.parsePower();
    while(this.peek().type === 'OP' && ['*','/','%'].includes(this.peek().value)){
      const op = this.advance().value;
      const right = this.parsePower();
      expr = {type:'BinaryOp', op, left:expr, right};
    }
    return expr;
  };

  Parser.prototype.parsePower = function(){
    let expr = this.parseUnary();
    if(this.peek().type === 'OP' && this.peek().value === '**'){
      this.advance();
      const right = this.parsePower();
      expr = {type:'BinaryOp', op:'**', left:expr, right};
    }
    return expr;
  };

  Parser.prototype.parseUnary = function(){
    if(this.peek().type === 'OP' && this.peek().value === '-'){
      this.advance();
      return {type:'UnaryOp', op:'-', argument:this.parseUnary()};
    }
    return this.parsePostfix();
  };

  Parser.prototype.parsePostfix = function(){
    let expr = this.parsePrimary();
    while(true){
      if(this.match('OP','.')){
        const name = this.expect('IDENT', undefined, 'Expected property name after dot').value;
        expr = {type:'Property', object:expr, name};
        continue;
      }
      if(this.match('OP','[')){
        const index = this.parseExpression();
        this.expect('OP',']');
        expr = {type:'Index', object:expr, index};
        continue;
      }
      if(this.match('OP','(')){
        const args = [];
        if(!this.match('OP',')')){
          do { args.push(this.parseExpression()); } while(this.match('OP',','));
          this.expect('OP',')');
        }
        expr = {type:'Call', callee:expr, args};
        continue;
      }
      break;
    }
    return expr;
  };

  Parser.prototype.parsePrimary = function(){
    const t = this.peek();
    if(t.type === 'NUMBER'){
      this.advance();
      return {type:'Literal', value: t.value.includes('.') ? parseFloat(t.value) : parseInt(t.value,10)};
    }
    if(t.type === 'STRING'){
      this.advance();
      return {type:'Literal', value:t.value};
    }
    if(t.type === 'KW' && (t.value === 'true' || t.value === 'false' || t.value === 'null')){
      this.advance();
      return {type:'Literal', value: t.value === 'true' ? true : (t.value === 'false' ? false : null)};
    }
    if(t.type === 'IDENT'){
      this.advance();
      return {type:'Identifier', name:t.value};
    }
    if(this.match('OP','(')){
      const first = this.parseExpression();
      if(this.match('OP',',')){
        const items = [first];
        do { items.push(this.parseExpression()); } while(this.match('OP',','));
        this.expect('OP',')');
        return {type:'TupleLiteral', items};
      }
      this.expect('OP',')');
      return first;
    }
    if(this.match('OP','[')){
      if(this.peek().type === 'IDENT' && this.peek(1).type === 'KW' && this.peek(1).value === 'in'){
        const varName = this.advance().value;
        this.advance(); // in
        const source = this.parseExpression();
        let where = null;
        if(this.peek().type === 'KW' && this.peek().value === 'where'){
          this.advance();
          where = this.parseExpression();
        }
        this.expect('OP',']');
        return {type:'Comprehension', varName, source, where};
      }
      const items = [];
      if(!this.match('OP',']')){
        do { items.push(this.parseExpression()); } while(this.match('OP',','));
        this.expect('OP',']');
      }
      return {type:'ListLiteral', items};
    }
    throw new SytError('Unexpected token in expression', t);
  };

  function Environment(parent){
    this.parent = parent || null;
    this.values = Object.create(null);
  }

  Environment.prototype.hasOwn = function(name){
    return Object.prototype.hasOwnProperty.call(this.values, name);
  };

  Environment.prototype.define = function(name, value){
    this.values[name] = value;
  };

  Environment.prototype.get = function(name){
    if(this.hasOwn(name)) return this.values[name];
    if(this.parent) return this.parent.get(name);
    throw new SytError('Undefined variable: ' + name);
  };

  Environment.prototype.set = function(name, value){
    if(this.hasOwn(name)){ this.values[name] = value; return; }
    if(this.parent){ this.parent.set(name, value); return; }
    this.values[name] = value;
  };

  function ReturnSignal(value){ this.value = value; }
  function BreakSignal(){}
  function ContinueSignal(){}

  function isTruthy(v){
    if(v === false || v === null) return false;
    if(v === 0 || v === 0.0) return false;
    if(v === '') return false;
    if(Array.isArray(v) && v.length === 0) return false;
    return true;
  }

  function isRenderableObject(v){
    return v && typeof v === 'object' && !Array.isArray(v);
  }

  function hasProperty(obj, propName){
    if(obj === null || obj === undefined) return false;
    if(Array.isArray(obj)) return false;
    return propName in obj;
  }

  function applyAssignOp(current, op, value){
    if(op === '=') return value;
    if(op === '+=') return current + value;
    if(op === '-=') return current - value;
    if(op === '*=') return current * value;
    if(op === '/=') return current / value;
    if(op === '%=') return current % value;
    throw new SytError('Unsupported assignment operator ' + op);
  }

  function Interpreter(context){
    this.context = context;
    this.global = new Environment(null);
    this.inFunction = 0;
    this.inLoop = 0;
    this.protectedNames = new Set(['All','Nodes','Lines','Terms','Arrows','Tree']);
    this.installBuiltins();
  }

  Interpreter.prototype.installBuiltins = function(){
    const c = this.context;
    this.global.define('All', c.All || []);
    this.global.define('Nodes', c.Nodes || []);
    this.global.define('Lines', c.Lines || []);
    this.global.define('Terms', c.Terms || []);
    this.global.define('Arrows', c.Arrows || []);
    this.global.define('Tree', c.Tree || {});

    const builtins = {
      len: function(x){ return x && x.length !== undefined ? x.length : 0; },
      type: function(x){
        if(x === null) return 'null';
        if(Array.isArray(x)) return 'list';
        return typeof x;
      },
      range: function(a,b,c){
        let start=0, end=0, step=1;
        if(arguments.length===1){ end = Number(a); }
        else if(arguments.length===2){ start = Number(a); end = Number(b); }
        else { start = Number(a); end = Number(b); step = Number(c); }
        if(step === 0) throw new SytError('range step cannot be 0');
        const out = [];
        if(step > 0){ for(let i=start;i<end;i+=step) out.push(i); }
        else { for(let i=start;i>end;i+=step) out.push(i); }
        return out;
      },
      min: function(){ return Math.min.apply(null, Array.prototype.slice.call(arguments)); },
      max: function(){ return Math.max.apply(null, Array.prototype.slice.call(arguments)); },
      abs: function(x){ return Math.abs(Number(x)); },
      int: function(x){ return parseInt(x, 10) || 0; },
      float: function(x){ return parseFloat(x) || 0; },
      str: function(x){ return String(x); },
      bool: function(x){ return isTruthy(x); },
      rgb: function(r,g,b){ return [Number(r)||0, Number(g)||0, Number(b)||0]; },
    };

    Object.keys(builtins).forEach(name=>this.global.define(name, {__builtin:true, name, fn:builtins[name]}));
  };

  Interpreter.prototype.executeProgram = function(program){
    const env = this.global;
    for(const stmt of program.body){
      this.executeStmt(stmt, env);
    }
    return this.context;
  };

  Interpreter.prototype.executeBlock = function(body, env){
    for(const stmt of body){
      this.executeStmt(stmt, env);
    }
  };

  Interpreter.prototype.executeStmt = function(stmt, env){
    switch(stmt.type){
      case 'Assign':
        this.assignTarget(stmt.target, stmt.op, stmt.value, env);
        return;
      case 'ExprStmt':
        this.evalExpr(stmt.expr, env);
        return;
      case 'IfStmt': {
        if(isTruthy(this.evalExpr(stmt.test, env))){
          this.executeBlock(stmt.consequent, new Environment(env));
          return;
        }
        for(const e of stmt.elifs){
          if(isTruthy(this.evalExpr(e.test, env))){
            this.executeBlock(e.body, new Environment(env));
            return;
          }
        }
        if(stmt.alternate) this.executeBlock(stmt.alternate, new Environment(env));
        return;
      }
      case 'WhileStmt': {
        this.inLoop++;
        try {
          while(isTruthy(this.evalExpr(stmt.test, env))){
            try {
              this.executeBlock(stmt.body, new Environment(env));
            } catch(e){
              if(e instanceof ContinueSignal) continue;
              if(e instanceof BreakSignal) break;
              throw e;
            }
          }
        } finally { this.inLoop--; }
        return;
      }
      case 'ForEachStmt': {
        const iterable = this.evalExpr(stmt.iterable, env);
        if(!Array.isArray(iterable)) throw new SytError('For each expects list/group iterable');
        this.inLoop++;
        try {
          for(const item of iterable){
            const loopEnv = new Environment(env);
            loopEnv.define(stmt.iterVar, item);
            try {
              this.executeBlock(stmt.body, loopEnv);
            } catch(e){
              if(e instanceof ContinueSignal) continue;
              if(e instanceof BreakSignal) break;
              throw e;
            }
          }
        } finally { this.inLoop--; }
        return;
      }
      case 'RepeatStmt': {
        const count = Number(this.evalExpr(stmt.countExpr, env));
        this.inLoop++;
        try {
          for(let i=0;i<count;i++){
            try {
              this.executeBlock(stmt.body, new Environment(env));
            } catch(e){
              if(e instanceof ContinueSignal) continue;
              if(e instanceof BreakSignal) break;
              throw e;
            }
          }
        } finally { this.inLoop--; }
        return;
      }
      case 'FuncDef': {
        const fnObj = {__userFn:true, name:stmt.name, params:stmt.params, body:stmt.body, closure:env};
        env.define(stmt.name, fnObj);
        return;
      }
      case 'ReturnStmt':
        if(this.inFunction <= 0) throw new SytError('return outside function');
        throw new ReturnSignal(stmt.value ? this.evalExpr(stmt.value, env) : null);
      case 'BreakStmt':
        if(this.inLoop <= 0) throw new SytError('break outside loop');
        throw new BreakSignal();
      case 'ContinueStmt':
        if(this.inLoop <= 0) throw new SytError('continue outside loop');
        throw new ContinueSignal();
      case 'PassStmt':
        return;
      default:
        throw new SytError('Unknown statement type: ' + stmt.type);
    }
  };

  Interpreter.prototype.assignTarget = function(target, op, valueExpr, env){
    const value = this.evalExpr(valueExpr, env);

    if(target.type === 'Identifier'){
      const name = target.name;
      if(env === this.global && this.protectedNames.has(name) && op === '='){
        throw new SytError('Cannot overwrite built-in global: ' + name);
      }
      const current = (op === '=') ? undefined : env.get(name);
      const next = applyAssignOp(current, op, value);
      if(env.hasOwn(name)) env.set(name, next);
      else if(env === this.global || env.get(name) === undefined) env.define(name, next);
      else env.set(name, next);
      return;
    }

    if(target.type === 'Property'){
      const obj = this.evalExpr(target.object, env);
      this.assignProperty(obj, target.name, op, value);
      return;
    }

    if(target.type === 'Index'){
      const obj = this.evalExpr(target.object, env);
      const idx = Number(this.evalExpr(target.index, env));
      if(!Array.isArray(obj)) throw new SytError('Index assignment target is not a list');
      if(idx < 0 || idx >= obj.length) throw new SytError('Index out of bounds');
      const current = obj[idx];
      obj[idx] = applyAssignOp(current, op, value);
      return;
    }

    throw new SytError('Invalid assignment target');
  };

  Interpreter.prototype.assignProperty = function(obj, name, op, value){
    if(Array.isArray(obj)){
      for(const item of obj){
        if(item && hasProperty(item, name)){
          const current = item[name];
          item[name] = applyAssignOp(current, op, value);
        }
      }
      return;
    }

    if(!isRenderableObject(obj)) throw new SytError('Invalid property assignment target');
    if(!hasProperty(obj, name)) throw new SytError('Invalid property access: ' + name);
    obj[name] = applyAssignOp(obj[name], op, value);
  };

  Interpreter.prototype.evalExpr = function(expr, env){
    switch(expr.type){
      case 'Identifier': return env.get(expr.name);
      case 'Literal': return expr.value;
      case 'UnaryOp': {
        const v = this.evalExpr(expr.argument, env);
        if(expr.op === '-') return -Number(v);
        if(expr.op === 'not') return !isTruthy(v);
        throw new SytError('Unknown unary operator: ' + expr.op);
      }
      case 'BinaryOp': {
        if(expr.op === 'and'){
          const l = this.evalExpr(expr.left, env);
          return isTruthy(l) ? this.evalExpr(expr.right, env) : l;
        }
        if(expr.op === 'or'){
          const l = this.evalExpr(expr.left, env);
          return isTruthy(l) ? l : this.evalExpr(expr.right, env);
        }
        const left = this.evalExpr(expr.left, env);
        const right = this.evalExpr(expr.right, env);
        return this.evalBinary(expr.op, left, right);
      }
      case 'Property': {
        const obj = this.evalExpr(expr.object, env);
        if(Array.isArray(obj)){
          const out = [];
          for(const item of obj){
            if(item && hasProperty(item, expr.name)) out.push(item[expr.name]);
          }
          return out;
        }
        if(!isRenderableObject(obj)) throw new SytError('Invalid property access');
        if(!hasProperty(obj, expr.name)) throw new SytError('Invalid property access: ' + expr.name);
        return obj[expr.name];
      }
      case 'Index': {
        const obj = this.evalExpr(expr.object, env);
        const idx = Number(this.evalExpr(expr.index, env));
        if(!Array.isArray(obj) && typeof obj !== 'string') throw new SytError('Index target is not indexable');
        if(idx < 0 || idx >= obj.length) throw new SytError('Index out of bounds');
        return obj[idx];
      }
      case 'Call': {
        const callee = this.evalExpr(expr.callee, env);
        const args = expr.args.map(a=>this.evalExpr(a, env));
        return this.callFunction(callee, args);
      }
      case 'TupleLiteral':
      case 'ListLiteral':
        return expr.items.map(item=>this.evalExpr(item, env));
      case 'Comprehension': {
        const src = this.evalExpr(expr.source, env);
        if(!Array.isArray(src)) throw new SytError('Comprehension source must be a list/group');
        const out = [];
        for(const item of src){
          const local = new Environment(env);
          local.define(expr.varName, item);
          if(!expr.where || isTruthy(this.evalExpr(expr.where, local))) out.push(item);
        }
        return out;
      }
      default:
        throw new SytError('Unknown expression type: ' + expr.type);
    }
  };

  Interpreter.prototype.evalBinary = function(op, left, right){
    if(op === '+') return left + right;
    if(op === '-'){
      if(typeof left === 'number' && typeof right === 'number') return left - right;
      if(isRenderableObject(left) && isRenderableObject(right)) return right.Parent === left;
      throw new SytError('Invalid operands for -');
    }
    if(op === '*') return left * right;
    if(op === '/') return left / right;
    if(op === '%') return left % right;
    if(op === '**') return Math.pow(left, right);
    if(op === '==') return left === right;
    if(op === '!=') return left !== right;
    if(op === '<') return left < right;
    if(op === '<=') return left <= right;
    if(op === '>') return left > right;
    if(op === '>=') return left >= right;
    if(op === 'in'){
      if(Array.isArray(right)) return right.includes(left);
      if(typeof right === 'string') return right.indexOf(String(left)) !== -1;
      return false;
    }
    if(op === 'not in') return !this.evalBinary('in', left, right);
    if(op === 'has'){
      const propName = (right && right.name) ? right.name : String(right);
      if(Array.isArray(left)) return false;
      return hasProperty(left, propName);
    }
    throw new SytError('Unknown operator: ' + op);
  };

  Interpreter.prototype.callFunction = function(callee, args){
    if(!callee) throw new SytError('Cannot call null value');
    if(callee.__builtin) return callee.fn.apply(null, args);
    if(callee.__userFn){
      if(args.length !== callee.params.length) throw new SytError('Invalid function arity for ' + callee.name);
      const fnEnv = new Environment(callee.closure);
      for(let i=0;i<callee.params.length;i++) fnEnv.define(callee.params[i], args[i]);
      this.inFunction++;
      try {
        this.executeBlock(callee.body, fnEnv);
      } catch(e){
        if(e instanceof ReturnSignal) return e.value;
        throw e;
      } finally {
        this.inFunction--;
      }
      return null;
    }
    throw new SytError('Value is not callable');
  };

  function parse(source){
    const tokens = tokenize(source);
    const parser = new Parser(tokens);
    return parser.parseProgram();
  }

  function run(source, runtimeContext){
    const program = parse(source);
    const interpreter = new Interpreter(runtimeContext || {});
    interpreter.executeProgram(program);
    return runtimeContext;
  }

  window.SYT = {
    tokenize,
    parse,
    run,
    SytError,
  };
})();
