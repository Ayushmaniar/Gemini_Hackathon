import { parse } from '@babel/parser';
import traverse_ from '@babel/traverse';
import * as t from '@babel/types';
import type { ValidationError, ValidationResult } from '../types';

// Handle both ESM and CJS exports for @babel/traverse
const traverse = typeof traverse_ === 'function' ? traverse_ : (traverse_ as any).default;

/**
 * Known globals that should not be flagged as undefined
 * Includes React hooks, Three.js, simulation context, and JavaScript built-ins
 */
const KNOWN_GLOBALS = new Set([
  // React
  'React', 'useFrame', 'useRef', 'useMemo', 'useEffect', 'useState', 'useCallback',
  'useLayoutEffect', 'useReducer', 'useContext', 'useImperativeHandle', 'useMemo',

  // Three.js
  'THREE',

  // Simulation context (injected by ThreeSandbox)
  'params', 'Text', 'useThree',

  // JavaScript built-ins
  'Math', 'Date', 'console', 'Array', 'Object', 'String', 'Number', 'Boolean',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'undefined', 'null', 'Infinity',
  'NaN', 'JSON', 'Promise', 'Set', 'Map', 'WeakMap', 'WeakSet', 'Symbol',
  'Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'requestAnimationFrame', 'cancelAnimationFrame',
  'Float32Array', 'Float64Array', 'Int8Array', 'Int16Array', 'Int32Array',
  'Uint8Array', 'Uint16Array', 'Uint32Array', 'Uint8ClampedArray',
  'ArrayBuffer', 'DataView',

  // Common in R3F code (passed via useThree or useFrame)
  'args', 'state', 'delta', 'clock', 'camera', 'scene', 'gl', 'raycaster',
  'pointer', 'size', 'viewport', 'mouse', 'performance', 'events',

  // Global objects
  'window', 'document', 'navigator', 'location', 'history',

  // Common array/object methods (not variables but sometimes flagged)
  'length', 'push', 'pop', 'shift', 'unshift', 'slice', 'splice',
  'map', 'filter', 'reduce', 'forEach', 'find', 'findIndex', 'some', 'every',
  'keys', 'values', 'entries', 'hasOwnProperty', 'toString', 'valueOf',
]);

interface ScopeInfo {
  declarations: Map<string, number>; // varName → lineNumber where declared
  usages: Map<string, number[]>;     // varName → [lineNumbers where used]
  functionParams: Set<string>;       // Function parameter names (valid in scope)
  parentScope?: ScopeInfo;           // Parent scope for nested functions
}

/**
 * Extract identifier names from function parameters (handles destructuring
 * and default values).
 *
 * Patterns handled:
 *   (x)                  → Identifier
 *   (x = 5)              → AssignmentPattern → Identifier
 *   ({ a, b })           → ObjectPattern → shorthand Identifier
 *   ({ a = 1, b = 2 })   → ObjectPattern → AssignmentPattern
 *   ({ a: renamed })     → ObjectPattern → Identifier value
 *   ({ a: renamed = 5 }) → ObjectPattern → AssignmentPattern value
 *   ([a, b])             → ArrayPattern → Identifier
 *   ([a = 1])            → ArrayPattern → AssignmentPattern
 *   ({ ...rest })        → RestElement
 */
function extractParamNames(param: any): string[] {
  const names: string[] = [];

  if (t.isIdentifier(param)) {
    names.push(param.name);
  } else if (t.isAssignmentPattern(param)) {
    // (x = 5) or inside destructuring: the left side is the actual name
    names.push(...extractParamNames(param.left));
  } else if (t.isObjectPattern(param)) {
    param.properties.forEach((prop: any) => {
      if (t.isObjectProperty(prop)) {
        // { a } → value is Identifier
        // { a = 1 } → value is AssignmentPattern(left=Identifier)
        // { a: renamed } → value is Identifier
        // { a: renamed = 5 } → value is AssignmentPattern(left=Identifier)
        names.push(...extractParamNames(prop.value));
      } else if (t.isRestElement(prop)) {
        // { ...rest }
        names.push(...extractParamNames(prop.argument));
      }
    });
  } else if (t.isArrayPattern(param)) {
    param.elements.forEach((el: any) => {
      if (el) {
        // [a] → Identifier,  [a = 1] → AssignmentPattern
        names.push(...extractParamNames(el));
      }
    });
  } else if (t.isRestElement(param)) {
    // (...rest) at top level
    names.push(...extractParamNames(param.argument));
  }

  return names;
}

/**
 * Validates simulation code for common errors that can be caught statically
 *
 * @param code - The JavaScript code to validate
 * @returns ValidationResult with errors found (if any)
 */
export function validateSimulationCode(code: string): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: string[] = [];

  try {
    // Parse the code into an AST
    const ast = parse(code, {
      sourceType: 'module',
      plugins: ['jsx', 'typescript'],
      errorRecovery: true, // Continue parsing even if there are syntax errors
    });

    // Create global scope
    const globalScope: ScopeInfo = {
      declarations: new Map(),
      usages: new Map(),
      functionParams: new Set(),
    };

    let currentScope = globalScope;
    const scopeStack: ScopeInfo[] = [globalScope];

    // Track all scopes to analyze after traversal
    const allScopes: ScopeInfo[] = [globalScope];

    // Track React elements stored in variables (for pattern detection)
    const reactElementVars = new Set<string>();

    // Traverse the AST to collect declarations and usages
    traverse(ast, {
      // Enter a new scope (function, arrow function, block)
      Function: {
        enter(path) {
          const newScope: ScopeInfo = {
            declarations: new Map(),
            usages: new Map(),
            functionParams: new Set(),
            parentScope: currentScope,
          };

          // Add function parameters to scope
          path.node.params.forEach((param) => {
            extractParamNames(param).forEach(name => newScope.functionParams.add(name));
          });

          scopeStack.push(newScope);
          currentScope = newScope;
          allScopes.push(newScope);
        },
        exit() {
          scopeStack.pop();
          currentScope = scopeStack[scopeStack.length - 1];
        },
      },

      // Block statements create scopes (for loops, if blocks, while loops, etc.)
      BlockStatement: {
        enter(path) {
          // Check if parent already created a scope (e.g., Function does its own)
          const parent = path.parent;
          // CatchClause bodies need their own scope with the catch parameter added
          const isCatchBody = t.isCatchClause(parent);
          const needsScope = !t.isFunction(parent) || isCatchBody;

          if (needsScope) {
            const newScope: ScopeInfo = {
              declarations: new Map(),
              usages: new Map(),
              functionParams: new Set(),
              parentScope: currentScope,
            };

            // Add catch clause parameter to scope (e.g., catch (err) { ... })
            if (isCatchBody && (parent as any).param) {
              extractParamNames((parent as any).param).forEach(
                name => newScope.functionParams.add(name)
              );
            }

            scopeStack.push(newScope);
            currentScope = newScope;
            allScopes.push(newScope);
            // Mark that we created a scope so we can pop it in exit
            (path.node as any).__hasScope = true;
          }
        },
        exit(path) {
          if ((path.node as any).__hasScope) {
            scopeStack.pop();
            currentScope = scopeStack[scopeStack.length - 1];
            delete (path.node as any).__hasScope;
          }
        },
      },

      // Track variable declarations (const, let, var)
      VariableDeclarator(path) {
        const id = path.node.id;
        const loc = path.node.loc;
        const line = loc?.start.line || 0;

        if (t.isIdentifier(id)) {
          currentScope.declarations.set(id.name, line);

          // Check if this is a React.createElement call for geometry
          const init = path.node.init;
          if (init && t.isCallExpression(init)) {
            // Direct: React.createElement('sphereGeometry', ...)
            if (
              t.isMemberExpression(init.callee) &&
              t.isIdentifier(init.callee.object, { name: 'React' }) &&
              t.isIdentifier(init.callee.property, { name: 'createElement' }) &&
              init.arguments.length > 0 &&
              t.isStringLiteral(init.arguments[0])
            ) {
              const elementType = init.arguments[0].value;
              if (elementType.toLowerCase().includes('geometry')) {
                reactElementVars.add(id.name);
              }
            }
            // Nested in useMemo: useMemo(() => React.createElement('sphereGeometry', ...), [])
            else if (
              t.isIdentifier(init.callee, { name: 'useMemo' }) &&
              init.arguments.length > 0
            ) {
              const callback = init.arguments[0];
              if (t.isArrowFunctionExpression(callback) || t.isFunctionExpression(callback)) {
                const body = callback.body;
                // Arrow function with expression body: () => React.createElement(...)
                if (
                  t.isCallExpression(body) &&
                  t.isMemberExpression(body.callee) &&
                  t.isIdentifier(body.callee.object, { name: 'React' }) &&
                  t.isIdentifier(body.callee.property, { name: 'createElement' }) &&
                  body.arguments.length > 0 &&
                  t.isStringLiteral(body.arguments[0])
                ) {
                  const elementType = body.arguments[0].value;
                  if (elementType.toLowerCase().includes('geometry')) {
                    reactElementVars.add(id.name);
                  }
                }
              }
            }
          }
        } else if (t.isObjectPattern(id)) {
          // Handle destructuring: const { x, y } = obj
          id.properties.forEach((prop) => {
            if (t.isObjectProperty(prop) && t.isIdentifier(prop.value)) {
              currentScope.declarations.set(prop.value.name, line);
            } else if (t.isRestElement(prop) && t.isIdentifier(prop.argument)) {
              currentScope.declarations.set(prop.argument.name, line);
            }
          });
        } else if (t.isArrayPattern(id)) {
          // Handle array destructuring: const [a, b] = arr
          id.elements.forEach((el) => {
            if (el && t.isIdentifier(el)) {
              currentScope.declarations.set(el.name, line);
            }
          });
        }
      },

      // Track function declarations
      FunctionDeclaration(path) {
        const id = path.node.id;
        const loc = path.node.loc;
        const line = loc?.start.line || 0;

        if (id && t.isIdentifier(id)) {
          // Function declarations are hoisted, but we still track them
          currentScope.declarations.set(id.name, line);
        }
      },

      // Detect React element variables used as THREE.js objects
      MemberExpression(path) {
        const obj = path.node.object;
        const prop = path.node.property;
        const loc = path.node.loc;
        const line = loc?.start.line || 0;

        // Check if object is a React element variable
        if (t.isIdentifier(obj) && reactElementVars.has(obj.name)) {
          if (t.isIdentifier(prop)) {
            const propName = prop.name;
            // Common THREE.js geometry/material properties/methods
            const threeJSMembers = ['clone', 'attributes', 'dispose', 'copy', 'computeBoundingSphere', 'computeVertexNormals'];

            if (threeJSMembers.includes(propName)) {
              warnings.push(
                `Line ${line}: Variable '${obj.name}' is a React element (created with React.createElement) ` +
                `but is being used as a THREE.js object (.${propName}). ` +
                `React elements should be used in JSX, not as THREE.js objects.`
              );
            }
          }
        }
      },

      // Track identifier usages (variable references)
      Identifier(path) {
        // Skip if this identifier is part of a declaration or property key
        if (
          path.parent &&
          (t.isVariableDeclarator(path.parent) && path.parent.id === path.node) ||
          (t.isFunctionDeclaration(path.parent) && path.parent.id === path.node) ||
          (t.isFunctionExpression(path.parent) && path.parent.id === path.node) ||
          (t.isObjectProperty(path.parent) && path.parent.key === path.node && !path.parent.computed) ||
          (t.isObjectMethod(path.parent) && path.parent.key === path.node && !path.parent.computed) ||
          (t.isClassMethod(path.parent) && path.parent.key === path.node && !path.parent.computed) ||
          (t.isClassProperty(path.parent) && path.parent.key === path.node && !path.parent.computed) ||
          (t.isMemberExpression(path.parent) && path.parent.property === path.node && !path.parent.computed) ||
          (t.isOptionalMemberExpression(path.parent) && path.parent.property === path.node && !path.parent.computed) ||
          (t.isClassDeclaration(path.parent) && path.parent.id === path.node) ||
          (t.isImportSpecifier(path.parent)) ||
          (t.isExportSpecifier(path.parent)) ||
          (t.isLabeledStatement(path.parent) && path.parent.label === path.node)
        ) {
          return; // Skip, this is not a usage
        }

        const name = path.node.name;
        const loc = path.node.loc;
        const line = loc?.start.line || 0;

        // Track usage in current scope
        if (!currentScope.usages.has(name)) {
          currentScope.usages.set(name, []);
        }
        currentScope.usages.get(name)!.push(line);
      },
    });

    // Analyze all scopes for errors
    for (const scope of allScopes) {
      scope.usages.forEach((lines, varName) => {
        // Skip known globals
        if (KNOWN_GLOBALS.has(varName)) {
          return;
        }

        // Check if variable is declared in current scope or parent scopes
        let isDeclared = false;
        let declarationLine = 0;
        let declarationScope: ScopeInfo | undefined = undefined;
        let searchScope: ScopeInfo | undefined = scope;

        while (searchScope) {
          if (searchScope.declarations.has(varName)) {
            isDeclared = true;
            declarationLine = searchScope.declarations.get(varName)!;
            declarationScope = searchScope;
            break;
          }
          if (searchScope.functionParams.has(varName)) {
            isDeclared = true;
            break; // Function params don't have a declaration line
          }
          searchScope = searchScope.parentScope;
        }

        if (!isDeclared) {
          // Variable is used but never declared (undefined variable)
          const firstUsageLine = lines[0];
          errors.push({
            type: 'undefined',
            variable: varName,
            line: firstUsageLine,
            column: 0,
            message: `'${varName}' is not defined`,
          });
        } else if (declarationLine > 0 && declarationScope === scope) {
          // Check for TDZ errors (usage before declaration)
          // Only check TDZ within the SAME scope - if declaration is in parent scope, it's already initialized
          // NOTE: Downgraded to warning because static TDZ detection has false positives
          // with nested block scopes (e.g., multiple for-loops declaring the same variable).
          // Real TDZ errors will be caught at runtime by the error boundary.
          const earlyUsages = lines.filter(usageLine => usageLine < declarationLine);
          if (earlyUsages.length > 0) {
            const firstEarlyUsage = earlyUsages[0];
            warnings.push(
              `Line ${firstEarlyUsage}: Possible TDZ - '${varName}' may be used before initialization (declared at line ${declarationLine})`
            );
          }
        }
      });
    }

  } catch (err) {
    // Syntax error during parsing
    if (err instanceof Error) {
      // Try to extract line/column from error message
      const lineMatch = err.message.match(/\((\d+):(\d+)\)/);
      const line = lineMatch ? parseInt(lineMatch[1], 10) : 0;
      const column = lineMatch ? parseInt(lineMatch[2], 10) : 0;

      errors.push({
        type: 'syntax',
        variable: '',
        line,
        column,
        message: `Syntax error: ${err.message}`,
      });
    } else {
      errors.push({
        type: 'syntax',
        variable: '',
        line: 0,
        column: 0,
        message: 'Unknown syntax error',
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}
