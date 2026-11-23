// TigerStyle linting rules for Effect TypeScript codebases (oxlint jsPlugins ESM module).
// Zero runtime dependencies. Uses bounded, non-recursive AST helpers.

const MAX_UNWRAP_DEPTH = 64;
const MAX_AST_NODES = 1024;
const AMBIGUOUS_BINDING = Symbol("ambiguous");

const BOUNDED_SCHEDULE_NAMES = new Set([
  "recurs",
  "once",
  "stop",
  "upTo",
  "whileInput",
  "whileOutput",
  "untilInput",
  "untilOutput",
  "recurWhile",
  "recurWhileEffect",
  "recurUntil",
  "recurUntilEffect",
  "check",
  "checkEffect",
]);

const UNBOUNDED_SCHEDULE_NAMES = new Set([
  "forever",
  "repeatForever",
  "spaced",
  "fixed",
  "exponential",
  "fibonacci",
  "linear",
  "windowed",
  "cron",
  "identity",
  "secondOfMinute",
  "minuteOfHour",
  "hourOfDay",
  "dayOfWeek",
  "dayOfMonth",
]);

const INTERSECT_SCHEDULE_NAMES = new Set(["intersect", "compose"]);
const UNION_SCHEDULE_NAMES = new Set(["union", "andThen"]);

const PASS_THROUGH_SCHEDULE_NAMES = new Set([
  "jittered",
  "jitteredWith",
  "delayed",
  "delayedEffect",
  "addDelay",
  "addDelayEffect",
  "map",
  "mapEffect",
  "mapInput",
  "mapInputEffect",
  "tapInput",
  "tapOutput",
  "as",
  "asVoid",
  "passthrough",
  "collectAllOutputs",
  "collectAllInputs",
  "repetitions",
  "elapsed",
  "delays",
  "modifyDelay",
  "modifyDelayEffect",
  "resetAfter",
  "resetWhen",
  "onDecision",
]);

const CATCH_HANDLER_METHODS = new Set([
  "catchAll",
  "catch",
  "catchTag",
  "catchAllCause",
  "catchAllDefect",
  "catchSome",
  "catchIf",
]);

const SYNC_SAFE_EFFECT_MEMBERS = new Set([
  "isEffect",
  "isFailure",
  "isSuccess",
  "runSync",
  "runSyncExit",
  "runPromise",
  "runPromiseExit",
  "runFork",
  "runCallback",
]);

const RUNNER_EFFECT_MEMBERS = new Set([
  "runSync",
  "runSyncExit",
  "runPromise",
  "runPromiseExit",
  "runFork",
  "runCallback",
]);

const VALUE_EFFECT_MEMBERS = new Set(["void", "never", "interrupt"]);

const DURATION_TERMS = new Set([
  "timeout",
  "delay",
  "interval",
  "ttl",
  "duration",
  "latency",
  "backoff",
  "cooldown",
]);

const BYTE_SIZE_QUALIFIERS = new Set([
  "max",
  "min",
  "buffer",
  "buf",
  "chunk",
  "file",
  "payload",
  "body",
  "message",
  "msg",
  "packet",
  "frame",
  "block",
  "memory",
  "mem",
  "heap",
  "stack",
  "cache",
  "disk",
  "storage",
  "data",
  "content",
  "response",
  "request",
  "upload",
  "download",
  "blob",
  "record",
  "entry",
]);

const SKIP_UNIT_PREFIXES = new Set([
  "is",
  "has",
  "should",
  "can",
  "will",
  "did",
  "on",
  "with",
  "enable",
  "disable",
  "use",
  "allow",
  "ignore",
  "skip",
]);

const UNIT_SAFE_TYPE_NAMES = new Set([
  "Duration",
  "DurationInput",
  "Timeout",
  "Timer",
  "Date",
  "RegExp",
  "Error",
]);

const SKIP_AST_KEYS = new Set([
  "parent",
  "loc",
  "range",
  "tokens",
  "comments",
  "start",
  "end",
]);

function isIdentifierNamed(node, name) {
  return Boolean(node && node.type === "Identifier" && node.name === name);
}

function isFunctionNode(node) {
  return Boolean(
    node &&
      (node.type === "FunctionDeclaration" ||
        node.type === "FunctionExpression" ||
        node.type === "ArrowFunctionExpression"),
  );
}

function getPropertyKeyName(key, computed) {
  if (!key) {
    return null;
  }
  if (!computed && key.type === "Identifier") {
    return key.name;
  }
  if (key.type === "Literal" && typeof key.value === "string") {
    return key.value;
  }
  return null;
}

function getMemberPropertyName(node) {
  if (!node || node.type !== "MemberExpression") {
    return null;
  }
  return getPropertyKeyName(node.property, node.computed);
}

function isNamespaceMember(node, namespace, propName) {
  if (!node || node.type !== "MemberExpression") {
    return false;
  }
  if (!isIdentifierNamed(node.object, namespace)) {
    return false;
  }
  if (propName === undefined) {
    return true;
  }
  return getMemberPropertyName(node) === propName;
}

function getEffectMethodName(callee) {
  if (!isNamespaceMember(callee, "Effect")) {
    return null;
  }
  return getMemberPropertyName(callee);
}

function getScheduleMemberName(expr) {
  if (!expr) {
    return null;
  }
  if (isNamespaceMember(expr, "Schedule")) {
    return getMemberPropertyName(expr);
  }
  if (expr.type === "CallExpression" && isNamespaceMember(expr.callee, "Schedule")) {
    return getMemberPropertyName(expr.callee);
  }
  return null;
}

function unwrapExpression(node) {
  let current = node;
  for (let depth = 0; depth < MAX_UNWRAP_DEPTH && current; depth += 1) {
    if (
      current.type === "ChainExpression" ||
      current.type === "ParenthesizedExpression" ||
      current.type === "TSAsExpression" ||
      current.type === "TSSatisfiesExpression" ||
      current.type === "TSNonNullExpression" ||
      current.type === "TSTypeAssertion"
    ) {
      current = current.expression;
    } else {
      break;
    }
  }
  return current;
}

function getConstantBooleanValue(node) {
  let current = unwrapExpression(node);
  let negated = false;
  for (let depth = 0; depth < MAX_UNWRAP_DEPTH && current; depth += 1) {
    if (current.type === "UnaryExpression" && current.operator === "!") {
      negated = !negated;
      current = unwrapExpression(current.argument);
    } else {
      break;
    }
  }
  if (!current || current.type !== "Literal") {
    return null;
  }
  const value = Boolean(current.value);
  return negated ? !value : value;
}

function getObjectProperty(objExpr, propName) {
  if (!objExpr || objExpr.type !== "ObjectExpression") {
    return null;
  }
  for (const prop of objExpr.properties) {
    if (prop.type === "Property" && getPropertyKeyName(prop.key, prop.computed) === propName) {
      return prop;
    }
  }
  return null;
}

function getPipeParts(node) {
  if (!node || node.type !== "CallExpression") {
    return null;
  }
  if (isIdentifierNamed(node.callee, "pipe") && node.arguments.length >= 1) {
    return { base: node.arguments[0], steps: node.arguments.slice(1) };
  }
  if (
    node.callee.type === "MemberExpression" &&
    getMemberPropertyName(node.callee) === "pipe"
  ) {
    return { base: node.callee.object, steps: node.arguments };
  }
  return null;
}

function combineIntersect(left, right) {
  if (left === "bounded" || right === "bounded") {
    return "bounded";
  }
  if (left === "unbounded" && right === "unbounded") {
    return "unbounded";
  }
  return "unknown";
}

function combineUnion(left, right) {
  if (left === "bounded" && right === "bounded") {
    return "bounded";
  }
  if (left === "unbounded" || right === "unbounded") {
    return "unbounded";
  }
  return "unknown";
}

function pushEvalResult(results, state) {
  results.push(state);
}

function enqueuePipeEval(stack, pipeParts) {
  stack.push({ kind: "pipe-combine", stepCount: pipeParts.steps.length });
  for (let i = pipeParts.steps.length - 1; i >= 0; i -= 1) {
    stack.push({ kind: "pipe-step", node: pipeParts.steps[i] });
  }
  stack.push({ kind: "expr", node: pipeParts.base });
}

function enqueueCallEval(stack, results, expr) {
  const pipeParts = getPipeParts(expr);
  if (pipeParts) {
    enqueuePipeEval(stack, pipeParts);
    return;
  }
  const scheduleName = getScheduleMemberName(expr);
  if (!scheduleName) {
    pushEvalResult(results, "unknown");
    return;
  }
  if (BOUNDED_SCHEDULE_NAMES.has(scheduleName)) {
    pushEvalResult(results, "bounded");
    return;
  }
  if (UNBOUNDED_SCHEDULE_NAMES.has(scheduleName)) {
    pushEvalResult(results, "unbounded");
    return;
  }
  if (INTERSECT_SCHEDULE_NAMES.has(scheduleName) && expr.arguments.length >= 2) {
    stack.push({ kind: "combine-intersect" });
    stack.push({ kind: "expr", node: expr.arguments[1] });
    stack.push({ kind: "expr", node: expr.arguments[0] });
    return;
  }
  if (UNION_SCHEDULE_NAMES.has(scheduleName) && expr.arguments.length >= 2) {
    stack.push({ kind: "combine-union" });
    stack.push({ kind: "expr", node: expr.arguments[1] });
    stack.push({ kind: "expr", node: expr.arguments[0] });
    return;
  }
  if (PASS_THROUGH_SCHEDULE_NAMES.has(scheduleName) && expr.arguments.length >= 1) {
    stack.push({ kind: "expr", node: expr.arguments[0] });
    return;
  }
  pushEvalResult(results, "unknown");
}

function enqueuePipeStepEval(stack, results, stepNode) {
  const step = unwrapExpression(stepNode);
  const name = getScheduleMemberName(step);
  if (!name) {
    pushEvalResult(results, { op: "unknown" });
    return;
  }
  if (BOUNDED_SCHEDULE_NAMES.has(name)) {
    pushEvalResult(results, { op: "bound" });
    return;
  }
  if (PASS_THROUGH_SCHEDULE_NAMES.has(name)) {
    pushEvalResult(results, { op: "keep" });
    return;
  }
  if (
    step.type === "CallExpression" &&
    step.arguments.length >= 1 &&
    INTERSECT_SCHEDULE_NAMES.has(name)
  ) {
    stack.push({ kind: "wrap-step", op: "intersect" });
    stack.push({ kind: "expr", node: step.arguments[0] });
    return;
  }
  if (
    step.type === "CallExpression" &&
    step.arguments.length >= 1 &&
    UNION_SCHEDULE_NAMES.has(name)
  ) {
    stack.push({ kind: "wrap-step", op: "union" });
    stack.push({ kind: "expr", node: step.arguments[0] });
    return;
  }
  pushEvalResult(results, { op: "unknown" });
}

function applyPipeCombine(results, stepCount) {
  const steps = results.splice(results.length - stepCount, stepCount);
  let state = results.pop();
  for (const step of steps) {
    if (step.op === "bound") {
      state = "bounded";
    } else if (step.op === "intersect") {
      state = combineIntersect(state, step.value);
    } else if (step.op === "union") {
      state = combineUnion(state, step.value);
    } else if (step.op === "unknown") {
      state = "unknown";
    }
  }
  results.push(state);
}

function evaluateExprFrame(exprNode, constInitializers, visitedIds, stack, results) {
  const expr = unwrapExpression(exprNode);
  if (!expr) {
    pushEvalResult(results, "unbounded");
    return;
  }
  if (expr.type === "Identifier") {
    const init = constInitializers.get(expr.name);
    if (!init || init === AMBIGUOUS_BINDING || visitedIds.has(expr.name)) {
      pushEvalResult(results, "unknown");
      return;
    }
    visitedIds.add(expr.name);
    stack.push({ kind: "expr", node: init });
    return;
  }
  if (expr.type === "ObjectExpression") {
    const hasDirectBound =
      getObjectProperty(expr, "times") ||
      getObjectProperty(expr, "while") ||
      getObjectProperty(expr, "until");
    if (hasDirectBound) {
      pushEvalResult(results, "bounded");
      return;
    }
    const scheduleProp = getObjectProperty(expr, "schedule");
    if (scheduleProp) {
      stack.push({ kind: "expr", node: scheduleProp.value });
      return;
    }
    pushEvalResult(results, "unbounded");
    return;
  }
  if (expr.type === "MemberExpression") {
    const name = getScheduleMemberName(expr);
    if (BOUNDED_SCHEDULE_NAMES.has(name)) {
      pushEvalResult(results, "bounded");
    } else if (UNBOUNDED_SCHEDULE_NAMES.has(name)) {
      pushEvalResult(results, "unbounded");
    } else {
      pushEvalResult(results, "unknown");
    }
    return;
  }
  if (expr.type === "CallExpression") {
    enqueueCallEval(stack, results, expr);
    return;
  }
  pushEvalResult(results, "unknown");
}

function evaluatePolicyBoundedness(rootExpr, constInitializers) {
  const stack = [{ kind: "expr", node: rootExpr }];
  const results = [];
  const visitedIds = new Set();

  for (let steps = 0; steps < MAX_AST_NODES && stack.length > 0; steps += 1) {
    const frame = stack.pop();
    if (frame.kind === "expr") {
      evaluateExprFrame(frame.node, constInitializers, visitedIds, stack, results);
    } else if (frame.kind === "pipe-step") {
      enqueuePipeStepEval(stack, results, frame.node);
    } else if (frame.kind === "wrap-step") {
      results.push({ op: frame.op, value: results.pop() });
    } else if (frame.kind === "pipe-combine") {
      applyPipeCombine(results, frame.stepCount);
    } else if (frame.kind === "combine-intersect") {
      const right = results.pop();
      const left = results.pop();
      results.push(combineIntersect(left, right));
    } else if (frame.kind === "combine-union") {
      const right = results.pop();
      const left = results.pop();
      results.push(combineUnion(left, right));
    }
  }

  return results.length === 1 ? results[0] : "unknown";
}

function getPolicyArgument(method, args) {
  if (method === "repeat" || method === "retry") {
    if (args.length === 0) {
      return { missing: true, node: null };
    }
    return { missing: false, node: args.length === 1 ? args[0] : args[1] };
  }
  if (method === "repeatOrElse" || method === "retryOrElse") {
    if (args.length < 2) {
      return { missing: true, node: null };
    }
    return { missing: false, node: args.length === 2 ? args[0] : args[1] };
  }
  return null;
}

function reportUnboundedRepeatOrRetry(node, method, constInitializers, context) {
  const policyArg = getPolicyArgument(method, node.arguments);
  if (!policyArg) {
    return;
  }
  if (policyArg.missing) {
    context.report({
      node,
      message: `TigerStyle: Effect.${method} lacks an explicit bound. Pass { times }, { while }, { until }, or a bounded Schedule such as Schedule.recurs(...).`,
    });
    return;
  }
  const boundedness = evaluatePolicyBoundedness(policyArg.node, constInitializers);
  if (boundedness === "unbounded") {
    context.report({
      node,
      message: `TigerStyle: Effect.${method} uses an unbounded policy. Add an explicit bound with { times }, { while }, { until }, Schedule.recurs(...), Schedule.upTo(...), or Schedule.intersect(..., Schedule.recurs(...)).`,
    });
  }
}

function checkPipeForever(node, context) {
  const pipeParts = getPipeParts(node);
  if (!pipeParts) {
    return;
  }
  for (const step of pipeParts.steps) {
    if (isNamespaceMember(unwrapExpression(step), "Effect", "forever")) {
      context.report({
        node: step,
        message:
          "TigerStyle: Effect.forever creates an unbounded loop. Use Effect.repeat with an explicit bound such as { times }, { while }, { until }, or Schedule.recurs.",
      });
    }
  }
}

const noUnboundedLoopRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow unbounded loops, Effect.forever, and Effect.repeat/Effect.retry calls without an explicit bound",
    },
    schema: [],
  },
  create(context) {
    const constInitializers = new Map();

    function checkConstantLoopTest(node) {
      if (getConstantBooleanValue(node.test) === true) {
        context.report({
          node,
          message:
            "TigerStyle: Unbounded loop detected. Put an explicit upper bound on loop iterations so execution always terminates.",
        });
      }
    }

    return {
      VariableDeclarator(node) {
        if (node.id.type !== "Identifier" || !node.init) {
          return;
        }
        constInitializers.set(
          node.id.name,
          constInitializers.has(node.id.name) ? AMBIGUOUS_BINDING : node.init,
        );
      },
      AssignmentExpression(node) {
        if (node.left.type === "Identifier") {
          constInitializers.set(node.left.name, AMBIGUOUS_BINDING);
        }
      },
      WhileStatement: checkConstantLoopTest,
      DoWhileStatement: checkConstantLoopTest,
      ForStatement(node) {
        if (!node.test || getConstantBooleanValue(node.test) === true) {
          context.report({
            node,
            message:
              "TigerStyle: Unbounded for-loop detected. Add an explicit termination bound to the loop condition.",
          });
        }
      },
      CallExpression(node) {
        checkPipeForever(node, context);
        const method = getEffectMethodName(node.callee);
        if (method === "forever") {
          context.report({
            node,
            message:
              "TigerStyle: Effect.forever creates an unbounded loop. Use Effect.repeat with an explicit bound such as { times }, { while }, { until }, or Schedule.recurs.",
          });
          return;
        }
        reportUnboundedRepeatOrRetry(node, method, constInitializers, context);
      },
    };
  },
};

function collectPatternIdentifiers(pattern, targetSet) {
  const stack = [pattern];
  for (let steps = 0; steps < MAX_AST_NODES && stack.length > 0; steps += 1) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    if (current.type === "Identifier") {
      targetSet.add(current.name);
    } else if (current.type === "AssignmentPattern") {
      stack.push(current.left);
    } else if (current.type === "RestElement") {
      stack.push(current.argument);
    } else if (current.type === "TSParameterProperty") {
      stack.push(current.parameter);
    } else if (current.type === "ArrayPattern") {
      for (const elem of current.elements) {
        if (elem) {
          stack.push(elem);
        }
      }
    } else if (current.type === "ObjectPattern") {
      for (const prop of current.properties) {
        stack.push(prop.type === "RestElement" ? prop.argument : prop.value);
      }
    }
  }
}

function getEffectFnWrappedFunction(callNode) {
  if (!callNode || callNode.type !== "CallExpression") {
    return null;
  }
  const directMethod = getEffectMethodName(callNode.callee);
  if ((directMethod === "fn" || directMethod === "fnUntraced") && isFunctionNode(callNode.arguments[0])) {
    return callNode.arguments[0];
  }
  if (callNode.callee.type === "CallExpression") {
    const outerMethod = getEffectMethodName(callNode.callee.callee);
    if (outerMethod === "fn" && isFunctionNode(callNode.arguments[0])) {
      return callNode.arguments[0];
    }
  }
  return null;
}

function getBoundFunctionFromInit(initNode) {
  const expr = unwrapExpression(initNode);
  if (!expr) {
    return null;
  }
  if (isFunctionNode(expr)) {
    return expr;
  }
  return getEffectFnWrappedFunction(expr);
}

function isDirectIdentifierRecursion(calleeName, fnStack, blockStack) {
  for (let i = fnStack.length - 1; i >= 0; i -= 1) {
    const frame = fnStack[i];
    const startBlock = frame.blockIndex;
    const endBlock = i === fnStack.length - 1 ? blockStack.length : fnStack[i + 1].blockIndex;
    for (let b = endBlock - 1; b >= startBlock; b -= 1) {
      if (blockStack[b].has(calleeName)) {
        return false;
      }
    }
    if (frame.paramNames.has(calleeName)) {
      return false;
    }
    if (frame.selfNames.has(calleeName)) {
      return true;
    }
  }
  return false;
}

function findThisMethodFrame(fnStack) {
  for (let i = fnStack.length - 1; i >= 0; i -= 1) {
    if (!fnStack[i].inheritsThis) {
      return fnStack[i];
    }
  }
  return null;
}

function findStaticMethodMatch(className, propName, fnStack) {
  for (let i = fnStack.length - 1; i >= 0; i -= 1) {
    const frame = fnStack[i];
    if (frame.isStatic && frame.className === className && frame.methodName === propName) {
      return true;
    }
  }
  return false;
}

function addBoundSelfName(boundSelfNames, fnNode, name) {
  if (!fnNode || !name) {
    return;
  }
  let names = boundSelfNames.get(fnNode);
  if (!names) {
    names = new Set();
    boundSelfNames.set(fnNode, names);
  }
  names.add(name);
}

function buildRecursionFrame(node, state) {
  const selfNames = new Set(state.boundSelfNames.get(node) ?? []);
  if (node.id && node.id.type === "Identifier") {
    selfNames.add(node.id.name);
  }
  const paramNames = new Set();
  for (const param of node.params) {
    collectPatternIdentifiers(param, paramNames);
  }
  const meta = state.methodMeta.get(node) ?? null;
  return {
    node,
    selfNames,
    paramNames,
    methodName: meta ? meta.methodName : null,
    className: meta ? meta.className : null,
    isStatic: meta ? meta.isStatic : false,
    inheritsThis: node.type === "ArrowFunctionExpression" || state.thisInheritingFns.has(node),
    blockIndex: state.blockStack.length,
  };
}

function checkRecursiveCall(node, state, context) {
  if (getEffectMethodName(node.callee) === "gen" && node.arguments.length >= 2) {
    if (node.arguments[0].type === "ThisExpression" && isFunctionNode(node.arguments[1])) {
      state.thisInheritingFns.add(node.arguments[1]);
    }
  }
  if (node.callee.type === "Identifier") {
    if (isDirectIdentifierRecursion(node.callee.name, state.fnStack, state.blockStack)) {
      context.report({
        node,
        message: `TigerStyle: Direct recursion in '${node.callee.name}' is disallowed. Rewrite as an explicit bounded loop to guarantee bounded execution and stack depth.`,
      });
    }
    return;
  }
  if (node.callee.type !== "MemberExpression") {
    return;
  }
  const propName = getMemberPropertyName(node.callee);
  if (!propName) {
    return;
  }
  if (node.callee.object.type === "ThisExpression") {
    const owner = findThisMethodFrame(state.fnStack);
    if (owner && owner.methodName === propName) {
      context.report({
        node,
        message: `TigerStyle: Direct recursion in method '${propName}' is disallowed. Rewrite as an explicit bounded loop to guarantee bounded execution and stack depth.`,
      });
    }
    return;
  }
  if (
    node.callee.object.type === "Identifier" &&
    findStaticMethodMatch(node.callee.object.name, propName, state.fnStack)
  ) {
    context.report({
      node,
      message: `TigerStyle: Direct recursion in static method '${node.callee.object.name}.${propName}' is disallowed. Rewrite as an explicit bounded loop to guarantee bounded execution and stack depth.`,
    });
  }
}

function recordMethodDefinition(node, state) {
  if (node.kind !== "method" || !isFunctionNode(node.value)) {
    return;
  }
  const methodName = getPropertyKeyName(node.key, node.computed);
  if (!methodName) {
    return;
  }
  const className = state.classStack.length > 0 ? state.classStack[state.classStack.length - 1] : null;
  state.methodMeta.set(node.value, { methodName, className, isStatic: Boolean(node.static) });
}

const noDirectRecursionRule = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow direct self-recursive functions and methods",
    },
    schema: [],
  },
  create(context) {
    const state = {
      fnStack: [],
      blockStack: [new Set()],
      classStack: [],
      boundSelfNames: new WeakMap(),
      methodMeta: new WeakMap(),
      thisInheritingFns: new WeakSet(),
    };

    const enterFunction = (node) => {
      state.fnStack.push(buildRecursionFrame(node, state));
      state.blockStack.push(new Set());
    };
    const exitFunction = () => {
      state.fnStack.pop();
      state.blockStack.pop();
    };
    const enterClass = (node) => {
      state.classStack.push(node.id && node.id.type === "Identifier" ? node.id.name : null);
    };
    const exitClass = () => {
      state.classStack.pop();
    };

    return {
      BlockStatement: () => state.blockStack.push(new Set()),
      "BlockStatement:exit": () => state.blockStack.pop(),
      ClassDeclaration: enterClass,
      "ClassDeclaration:exit": exitClass,
      ClassExpression: enterClass,
      "ClassExpression:exit": exitClass,
      MethodDefinition: (node) => recordMethodDefinition(node, state),
      VariableDeclarator(node) {
        const boundFn = getBoundFunctionFromInit(node.init);
        if (node.id.type === "Identifier" && boundFn) {
          addBoundSelfName(state.boundSelfNames, boundFn, node.id.name);
        } else {
          collectPatternIdentifiers(node.id, state.blockStack[state.blockStack.length - 1]);
        }
      },
      "VariableDeclarator:exit"(node) {
        if (node.id.type === "Identifier" && getBoundFunctionFromInit(node.init)) {
          state.blockStack[state.blockStack.length - 1].add(node.id.name);
        }
      },
      AssignmentExpression(node) {
        if (node.operator === "=" && node.left.type === "Identifier") {
          const boundFn = getBoundFunctionFromInit(node.right);
          if (boundFn) {
            addBoundSelfName(state.boundSelfNames, boundFn, node.left.name);
          }
        }
      },
      FunctionDeclaration: enterFunction,
      "FunctionDeclaration:exit": exitFunction,
      FunctionExpression: enterFunction,
      "FunctionExpression:exit": exitFunction,
      ArrowFunctionExpression: enterFunction,
      "ArrowFunctionExpression:exit": exitFunction,
      CallExpression: (node) => checkRecursiveCall(node, state, context),
    };
  },
};

function isUndefinedExpr(expr) {
  const node = unwrapExpression(expr);
  if (!node) {
    return true;
  }
  if (node.type === "Identifier" && node.name === "undefined") {
    return true;
  }
  return node.type === "UnaryExpression" && node.operator === "void";
}

function isEmptyGeneratorOrSync(callExpr) {
  const method = getEffectMethodName(callExpr.callee);
  if (method === "gen") {
    const genFn = callExpr.arguments.length >= 2 ? callExpr.arguments[1] : callExpr.arguments[0];
    return Boolean(
      isFunctionNode(genFn) &&
        genFn.body.type === "BlockStatement" &&
        genFn.body.body.length === 0,
    );
  }
  if (method === "sync") {
    const cb = callExpr.arguments[0];
    if (!isFunctionNode(cb)) {
      return false;
    }
    if (cb.body.type === "BlockStatement") {
      return cb.body.body.length === 0;
    }
    return isUndefinedExpr(cb.body);
  }
  return false;
}

function isNoOpEffectExpr(expr) {
  const node = unwrapExpression(expr);
  if (!node || isUndefinedExpr(node)) {
    return true;
  }
  if (isNamespaceMember(node, "Effect", "void")) {
    return true;
  }
  if (node.type !== "CallExpression") {
    return false;
  }
  const method = getEffectMethodName(node.callee);
  if (method === "succeed") {
    return node.arguments.length === 0 || isUndefinedExpr(node.arguments[0]);
  }
  return isEmptyGeneratorOrSync(node);
}

function isSilentErrorHandler(fnNode) {
  if (!isFunctionNode(fnNode)) {
    return false;
  }
  if (fnNode.body.type !== "BlockStatement") {
    return isNoOpEffectExpr(fnNode.body);
  }
  const statements = fnNode.body.body;
  if (statements.length === 0) {
    return true;
  }
  if (statements.length === 1 && statements[0].type === "ReturnStatement") {
    return isNoOpEffectExpr(statements[0].argument);
  }
  return false;
}

const noSwallowedErrorRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow empty catch blocks, Effect.ignore, and Effect catch handlers that silently discard errors",
    },
    schema: [],
  },
  create(context) {
    function reportSilentHandler(handlerNode, methodName) {
      context.report({
        node: handlerNode,
        message: `TigerStyle: Effect.${methodName} handler silently discards the error. Log or handle the error, map it with Effect.fail, or return a meaningful recovery value.`,
      });
    }

    return {
      CatchClause(node) {
        if (node.body && node.body.body.length === 0) {
          context.report({
            node,
            message:
              "TigerStyle: Empty catch block silently swallows errors. Log or handle the error, or propagate it via Effect.fail.",
          });
        }
      },
      CallExpression(node) {
        const pipeParts = getPipeParts(node);
        if (pipeParts) {
          for (const step of pipeParts.steps) {
            if (isNamespaceMember(unwrapExpression(step), "Effect", "ignore")) {
              context.report({
                node: step,
                message:
                  "TigerStyle: Effect.ignore silently discards errors. Handle the error explicitly or use Effect.ignoreLogged if discarding after logging is intentional.",
              });
            }
          }
        }
        const method = getEffectMethodName(node.callee);
        if (!method) {
          return;
        }
        if (method === "ignore") {
          context.report({
            node,
            message:
              "TigerStyle: Effect.ignore silently discards errors. Handle the error explicitly or use Effect.ignoreLogged if discarding after logging is intentional.",
          });
          return;
        }
        if (CATCH_HANDLER_METHODS.has(method) && node.arguments.length >= 1) {
          const handler = node.arguments[node.arguments.length - 1];
          if (isSilentErrorHandler(handler)) {
            reportSilentHandler(handler, method);
          }
          return;
        }
        if (method === "catchTags" && node.arguments.length >= 1) {
          const handlersObj = unwrapExpression(node.arguments[node.arguments.length - 1]);
          if (handlersObj && handlersObj.type === "ObjectExpression") {
            for (const prop of handlersObj.properties) {
              if (prop.type === "Property" && isSilentErrorHandler(prop.value)) {
                reportSilentHandler(prop.value, "catchTags");
              }
            }
          }
        }
      },
    };
  },
};

function pushAstChildren(node, stack) {
  for (const key of Object.keys(node)) {
    if (SKIP_AST_KEYS.has(key)) {
      continue;
    }
    const child = node[key];
    if (!child || typeof child !== "object") {
      continue;
    }
    if (Array.isArray(child)) {
      for (let i = child.length - 1; i >= 0; i -= 1) {
        if (child[i] && typeof child[i].type === "string") {
          stack.push(child[i]);
        }
      }
    } else if (typeof child.type === "string") {
      stack.push(child);
    }
  }
}

function findNestedEffectsInCallback(callbackNode, containerName, context) {
  const stack = [callbackNode.body];
  for (let steps = 0; steps < MAX_AST_NODES && stack.length > 0; steps += 1) {
    const current = stack.pop();
    if (!current || typeof current.type !== "string") {
      continue;
    }
    if (
      isFunctionNode(current) ||
      current.type === "ClassDeclaration" ||
      current.type === "ClassExpression"
    ) {
      continue;
    }
    if (current.type === "CallExpression") {
      const method = getEffectMethodName(current.callee);
      if (method) {
        if (RUNNER_EFFECT_MEMBERS.has(method)) {
          continue;
        }
        if (!SYNC_SAFE_EFFECT_MEMBERS.has(method)) {
          context.report({
            node: current,
            message: `TigerStyle: Unexecuted Effect.${method}(...) inside ${containerName} callback is silently dropped. Compose effects with Effect.gen, Effect.flatMap, or Effect.tap instead.`,
          });
          continue;
        }
      }
    } else if (current.type === "MemberExpression" && isNamespaceMember(current, "Effect")) {
      const prop = getMemberPropertyName(current);
      if (VALUE_EFFECT_MEMBERS.has(prop)) {
        context.report({
          node: current,
          message: `TigerStyle: Unexecuted Effect.${prop} inside ${containerName} callback is silently dropped. Compose effects with Effect.gen, Effect.flatMap, or Effect.tap instead.`,
        });
        continue;
      }
    }
    pushAstChildren(current, stack);
  }
}

function getSyncCallbacks(callNode) {
  const method = getEffectMethodName(callNode.callee);
  if (method !== "sync" && method !== "try" && method !== "tryPromise") {
    return [];
  }
  const firstArg = unwrapExpression(callNode.arguments[0]);
  if (!firstArg) {
    return [];
  }
  if (isFunctionNode(firstArg)) {
    return [{ callback: firstArg, label: `Effect.${method}` }];
  }
  if ((method === "try" || method === "tryPromise") && firstArg.type === "ObjectExpression") {
    const callbacks = [];
    const tryProp = getObjectProperty(firstArg, "try");
    if (tryProp && isFunctionNode(tryProp.value)) {
      callbacks.push({ callback: tryProp.value, label: `Effect.${method}.try` });
    }
    const catchProp = getObjectProperty(firstArg, "catch");
    if (catchProp && isFunctionNode(catchProp.value)) {
      callbacks.push({ callback: catchProp.value, label: `Effect.${method}.catch` });
    }
    return callbacks;
  }
  return [];
}

const noNestedEffectInSyncRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow constructing or returning unexecuted Effect values inside Effect.sync or Effect.try callbacks",
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        const callbacks = getSyncCallbacks(node);
        for (const entry of callbacks) {
          findNestedEffectsInCallback(entry.callback, entry.label, context);
        }
      },
    };
  },
};

function getTrackedEffectGenerator(callNode) {
  const method = getEffectMethodName(callNode.callee);
  if (method === "gen") {
    if (callNode.arguments.length >= 2 && isFunctionNode(callNode.arguments[1])) {
      return callNode.arguments[1];
    }
    if (callNode.arguments.length >= 1 && isFunctionNode(callNode.arguments[0])) {
      return callNode.arguments[0];
    }
    return null;
  }
  return getEffectFnWrappedFunction(callNode);
}

const noUntrackedThrowRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow raw throw statements inside Effect.gen and Effect.fn bodies; use Effect.fail or Effect.die",
    },
    schema: [],
  },
  create(context) {
    const trackedGenerators = new WeakSet();
    const fnStack = [];

    function enterFunction(node) {
      fnStack.push(trackedGenerators.has(node));
    }

    function exitFunction() {
      fnStack.pop();
    }

    return {
      CallExpression(node) {
        const genFn = getTrackedEffectGenerator(node);
        if (genFn) {
          trackedGenerators.add(genFn);
        }
      },
      FunctionDeclaration: enterFunction,
      "FunctionDeclaration:exit": exitFunction,
      FunctionExpression: enterFunction,
      "FunctionExpression:exit": exitFunction,
      ArrowFunctionExpression: enterFunction,
      "ArrowFunctionExpression:exit": exitFunction,
      ThrowStatement(node) {
        if (fnStack.length > 0 && fnStack[fnStack.length - 1] === true) {
          context.report({
            node,
            message:
              "TigerStyle: Avoid raw throw inside Effect.gen/Effect.fn. Use yield* Effect.fail(...) for expected domain errors or yield* Effect.die(...) for programmer bugs and invariant violations.",
          });
        }
      },
    };
  },
};

function splitIdentifierWords(name) {
  const trimmed = name.replace(/^_+|_+$/g, "");
  if (!trimmed) {
    return [];
  }
  return trimmed
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()
    .split("_")
    .filter(Boolean);
}

function classifyUnitlessIdentifier(name) {
  if (/^_?[A-Z][a-z]/.test(name)) {
    return null;
  }
  const words = splitIdentifierWords(name);
  if (words.length === 0 || SKIP_UNIT_PREFIXES.has(words[0])) {
    return null;
  }
  const last = words[words.length - 1];
  if (DURATION_TERMS.has(last)) {
    return "duration";
  }
  if (last === "size" && words.length >= 2 && BYTE_SIZE_QUALIFIERS.has(words[words.length - 2])) {
    return "size";
  }
  return null;
}

function getTypeReferenceName(typeName) {
  if (!typeName) {
    return null;
  }
  if (typeName.type === "Identifier") {
    return typeName.name;
  }
  if (typeName.type === "TSQualifiedName" && typeName.right.type === "Identifier") {
    return typeName.right.name;
  }
  return null;
}

function isUnitSafeLeafType(typeNode) {
  if (!typeNode) {
    return false;
  }
  if (
    typeNode.type === "TSBooleanKeyword" ||
    typeNode.type === "TSStringKeyword" ||
    typeNode.type === "TSFunctionType"
  ) {
    return true;
  }
  if (typeNode.type === "TSTypeReference") {
    const refName = getTypeReferenceName(typeNode.typeName);
    return Boolean(refName && UNIT_SAFE_TYPE_NAMES.has(refName));
  }
  return false;
}

function isUnitSafeTypeNode(rootTypeNode) {
  if (!rootTypeNode) {
    return false;
  }
  const stack = [rootTypeNode];
  let checkedNonNullish = false;
  for (let steps = 0; steps < MAX_UNWRAP_DEPTH && stack.length > 0; steps += 1) {
    const current = stack.pop();
    if (!current || current.type === "TSUndefinedKeyword" || current.type === "TSNullKeyword") {
      continue;
    }
    if (current.type === "TSParenthesizedType") {
      stack.push(current.typeAnnotation);
      continue;
    }
    if (current.type === "TSUnionType") {
      for (const member of current.types) {
        stack.push(member);
      }
      continue;
    }
    checkedNonNullish = true;
    if (!isUnitSafeLeafType(current)) {
      return false;
    }
  }
  return checkedNonNullish;
}

function isUnitSafeTypeAnnotation(typeAnnotation) {
  if (!typeAnnotation || typeAnnotation.type !== "TSTypeAnnotation") {
    return false;
  }
  return isUnitSafeTypeNode(typeAnnotation.typeAnnotation);
}

function isUnitSafeInitializer(initNode) {
  const expr = unwrapExpression(initNode);
  if (!expr) {
    return false;
  }
  if (isFunctionNode(expr)) {
    return true;
  }
  if (expr.type === "Literal" && (typeof expr.value === "string" || typeof expr.value === "boolean")) {
    return true;
  }
  if (expr.type === "CallExpression") {
    if (isNamespaceMember(expr.callee, "Duration")) {
      return true;
    }
    if (isIdentifierNamed(expr.callee, "setTimeout") || isIdentifierNamed(expr.callee, "setInterval")) {
      return true;
    }
  }
  return false;
}

const requireUnitSuffixRule = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Require explicit unit suffixes on duration and size identifiers (for example Ms/_ms, Seconds/_s, Bytes/_bytes, Kb/Mb)",
    },
    schema: [],
  },
  create(context) {
    function checkIdentifier(idNode, typeAnnotation, initNode) {
      if (!idNode || idNode.type !== "Identifier") {
        return;
      }
      if (isUnitSafeTypeAnnotation(typeAnnotation) || isUnitSafeInitializer(initNode)) {
        return;
      }
      const kind = classifyUnitlessIdentifier(idNode.name);
      if (!kind) {
        return;
      }
      const usesSnakeCase = idNode.name.includes("_");
      if (kind === "duration") {
        const examples = usesSnakeCase
          ? `'${idNode.name}_ms' or '${idNode.name}_s'`
          : `'${idNode.name}Ms' or '${idNode.name}Seconds'`;
        context.report({
          node: idNode,
          message: `TigerStyle: Duration identifier '${idNode.name}' omits a unit suffix. Append an explicit unit (such as ${examples}) or type it with Effect's Duration.`,
        });
        return;
      }
      const examples = usesSnakeCase
        ? `'${idNode.name}_bytes' or '${idNode.name}_kb'`
        : `'${idNode.name}Bytes' or '${idNode.name}Kb'`;
      context.report({
        node: idNode,
        message: `TigerStyle: Size identifier '${idNode.name}' omits a unit suffix. Append an explicit unit (such as ${examples}).`,
      });
    }

    function checkFunctionParams(node) {
      for (const rawParam of node.params) {
        let param = rawParam;
        let defaultInit = null;
        if (param.type === "TSParameterProperty") {
          param = param.parameter;
        }
        if (param.type === "AssignmentPattern") {
          defaultInit = param.right;
          param = param.left;
        }
        if (param.type === "Identifier") {
          checkIdentifier(param, param.typeAnnotation, defaultInit);
        }
      }
    }

    return {
      VariableDeclarator(node) {
        if (node.id.type === "Identifier") {
          checkIdentifier(node.id, node.id.typeAnnotation, node.init);
        }
      },
      FunctionDeclaration: checkFunctionParams,
      FunctionExpression: checkFunctionParams,
      ArrowFunctionExpression: checkFunctionParams,
      PropertyDefinition(node) {
        if (!node.computed && node.key.type === "Identifier") {
          checkIdentifier(node.key, node.typeAnnotation, node.value);
        }
      },
      TSPropertySignature(node) {
        if (!node.computed && node.key.type === "Identifier") {
          checkIdentifier(node.key, node.typeAnnotation, null);
        }
      },
    };
  },
};

const plugin = {
  meta: {
    name: "tigerstyle-effect",
    version: "0.1.0",
  },
  rules: {
    "no-unbounded-loop": noUnboundedLoopRule,
    "no-direct-recursion": noDirectRecursionRule,
    "no-swallowed-error": noSwallowedErrorRule,
    "no-nested-effect-in-sync": noNestedEffectInSyncRule,
    "no-untracked-throw": noUntrackedThrowRule,
    "require-unit-suffix": requireUnitSuffixRule,
  },
};

export default plugin;
