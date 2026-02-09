import { Section, Slide, QuizQuestion, InteractiveConfig, ControlParam, SectionContent, LearningLevel, ChatMessage, SimulationEdit, SimulationEditResult, SimEditHistoryItem } from "../types";
import { compressSlideHtml } from "../utils/htmlUtils";
import { devLogger } from "./devLogger";
import { validateSimulationCode } from "../utils/codeValidator";

// ============================================================================
// Model Configuration: Gemini 3.0 Flash + Pro Hybrid Approach
// ============================================================================
// Content generation uses a tiered approach:
// - Fast tier (Gemini 3.0 Flash): Syllabus, slides, quiz, speaker notes, chatbot
//   - ~3x faster response times (better UX)
//   - Cost-effective for most tasks ($0.50 vs $2-4 input for Pro)
// - Capable tier (Gemini 3.0 Pro): 3D simulation code generation
//   - Higher quality for complex code generation tasks
//   - Better handling of React Three Fiber code requirements
//
// Note: TTS model (gemini-2.5-flash-preview-tts) remains unchanged as it's
// a specialized model family for speech synthesis.
// ============================================================================

// ============================================================================
// API Configuration
// ============================================================================

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models";

// Get the active provider for display purposes
export const getProviderDisplayName = (): string => {
  return 'Google Gemini 3.0 (Flash + Pro)';
};

// ============================================================================
// Model Configuration
// ============================================================================

type ModelTier = 'fast' | 'capable';

// Model configuration: Fast tier uses Flash for speed, Capable tier uses Pro for quality
// Gemini 3.0 Flash is 3x faster than Pro and good for most tasks
// Gemini 3.0 Pro provides higher quality for complex generation tasks like 3D code
const MODEL_MAP: Record<ModelTier, string> = {
  fast: 'gemini-3-flash-preview',
  capable: 'gemini-3-pro-preview'  // Pro model for high-quality 3D code generation
};

// Get the appropriate model for the given tier
const getModel = (tier: ModelTier): string => {
  return MODEL_MAP[tier];
};

// ============================================================================
// Gemini Schema Sanitizer
// ============================================================================

// Gemini API supports a subset of JSON Schema. This function removes unsupported properties.
// Unsupported: additionalProperties, $schema, $id, $ref (in some contexts)
function sanitizeSchemaForGemini(schema: any): any {
  if (schema === null || typeof schema !== 'object') {
    return schema;
  }

  if (Array.isArray(schema)) {
    return schema.map(item => sanitizeSchemaForGemini(item));
  }

  const sanitized: any = {};
  
  for (const [key, value] of Object.entries(schema)) {
    // Skip unsupported properties
    if ([
      'additionalProperties',
      '$schema',
      '$id',
      'definitions',
      '$defs'
    ].includes(key)) {
      continue;
    }
    
    // Recursively sanitize nested objects
    sanitized[key] = sanitizeSchemaForGemini(value);
  }

  return sanitized;
}

// ============================================================================
// Simulation Code Sanitizer
// ============================================================================
// Catches common AI-generation mistakes where THREE.js constructors are used
// directly instead of the declarative R3F React.createElement syntax.
// e.g.  new THREE.BoxGeometry(1,1,1)  ->  React.createElement('boxGeometry', { args: [1,1,1] })

const R3F_GEOMETRY_TYPES = [
  'BoxGeometry', 'SphereGeometry', 'CylinderGeometry', 'ConeGeometry',
  'PlaneGeometry', 'TorusGeometry', 'CircleGeometry', 'RingGeometry',
  'TorusKnotGeometry', 'TubeGeometry',
];

const R3F_MATERIAL_TYPES = [
  'MeshBasicMaterial', 'MeshStandardMaterial', 'MeshPhongMaterial',
  'MeshLambertMaterial', 'MeshNormalMaterial',
  'LineBasicMaterial', 'LineDashedMaterial', 'PointsMaterial',
];

// Unicode superscript/subscript -> plain ASCII mapping.
// The troika-3d-text font used by @react-three/drei Text lacks glyphs for these
// characters, causing them to render as box (☒) placeholders.
const UNICODE_TO_ASCII: Record<string, string> = {
  // Superscripts
  '\u2070': '0', '\u00B9': '1', '\u00B2': '2', '\u00B3': '3',
  '\u2074': '4', '\u2075': '5', '\u2076': '6', '\u2077': '7',
  '\u2078': '8', '\u2079': '9', '\u207A': '+', '\u207B': '-',
  '\u207C': '=', '\u207D': '(', '\u207E': ')', '\u207F': 'n',
  // Subscripts
  '\u2080': '0', '\u2081': '1', '\u2082': '2', '\u2083': '3',
  '\u2084': '4', '\u2085': '5', '\u2086': '6', '\u2087': '7',
  '\u2088': '8', '\u2089': '9', '\u208A': '+', '\u208B': '-',
  '\u208C': '=', '\u208D': '(', '\u208E': ')',
  // Common math symbols that fonts may lack
  '\u00D7': 'x',   // ×
  '\u00F7': '/',   // ÷
  '\u00B1': '+/-', // ±
  '\u00B7': '.',   // ·
  '\u2013': '-',   // en-dash
  '\u2014': '--',  // em-dash
  '\u2212': '-',   // minus sign
};

// Precompiled regex for all Unicode chars to replace
const UNICODE_REPLACE_RE = new RegExp(
  '[' + Object.keys(UNICODE_TO_ASCII).join('') + ']',
  'g'
);

// ============================================================================
// React Three Fiber Error Patterns
// ============================================================================
// Common error patterns in AI-generated R3F code with their fixes.
// Used by both generateInteractiveCodeErrorCorrection and fixSimulationCodeWithPatch.
const R3F_ERROR_PATTERNS = `
COMMON ERROR PATTERNS AND FIXES:

1. **"LineDashMaterial is not part of the THREE namespace"**
   - WRONG: React.createElement('lineDashMaterial', ...)
   - CORRECT: Use 'lineBasicMaterial' or 'lineDashedMaterial' (these exist in THREE.js)

2. **"e.getIndex is not a function"** or **geometry errors**
   - WRONG: Passing a standard geometry to 'line' or 'points' elements incorrectly
   - CORRECT: For lines, create BufferGeometry via React.useMemo:
     \`\`\`
     const lineGeo = React.useMemo(() => {
       const geo = new THREE.BufferGeometry();
       geo.setFromPoints([new THREE.Vector3(0,0,0), new THREE.Vector3(1,0,0)]);
       return geo;
     }, []);
     React.createElement('line', { geometry: lineGeo }, React.createElement('lineBasicMaterial', { color: '#fff' }))
     \`\`\`

3. **"e.remove is not a function"** or **removeFromParent errors**
   - WRONG: Calling methods on wrong object types or trying to remove incompatible objects
   - CORRECT: Ensure you're working with proper THREE.js Object3D instances

4. **"Objects are not valid as a React child"**
   - WRONG: React.createElement('mesh', null, new THREE.BoxGeometry(1,1,1))
   - CORRECT: React.createElement('mesh', null, React.createElement('boxGeometry', { args: [1,1,1] }))

5. **"Cannot convert undefined or null to object"**
   - WRONG: Accessing properties on undefined objects or refs not yet initialized
   - CORRECT: Add null checks: if (ref.current) { ... }

6. **"Cannot read properties of undefined (reading 'center')" / boundingSphere errors**
   - The runtime automatically sets frustumCulled=false on all 3D elements, so this should not occur
   - Do NOT call .computeBoundingSphere() anywhere — the runtime handles frustum culling
   - If you see this error, just remove any .computeBoundingSphere() calls from the code

7. **"attr.computeBoundingSphere is not a function"**
   - WRONG: Calling .computeBoundingSphere() on a BufferAttribute (e.g. geometry.attributes.position)
   - WRONG: \`const attr = ref.current.geometry.attributes.position; attr.computeBoundingSphere();\`
   - CORRECT: Simply remove all .computeBoundingSphere() calls. The runtime handles this automatically via frustumCulled=false.
   - BufferAttribute does NOT have a computeBoundingSphere method — only BufferGeometry does.
   - This error fires every frame inside useFrame, causing thousands of console errors.

8. **"geometry.addEventListener is not a function"** or **"_.addEventListener is not a function"**
   - This happens when a React element is passed as the \`geometry\` prop on a mesh instead of a THREE.BufferGeometry instance.
   - WRONG: Caching a React element in useMemo, then using it as geometry prop:
     \`\`\`
     const sphereGeo = React.useMemo(() => React.createElement('sphereGeometry', { args: [1, 32, 32] }), []);
     React.createElement('mesh', { geometry: sphereGeo }, ...) // CRASH!
     \`\`\`
   - WRONG: Using React element with primitive:
     \`\`\`
     const torusGeo = React.useMemo(() => React.createElement('torusGeometry', { args: [3, 0.4, 16, 50] }), []);
     React.createElement('primitive', { object: torusGeo }) // CRASH!
     \`\`\`
   - CORRECT FOR MESH: Put geometry as a CHILD element, never as a prop, and don't cache it in useMemo:
     \`\`\`
     React.createElement('mesh', null,
       React.createElement('sphereGeometry', { args: [1, 32, 32] }),
       React.createElement('meshStandardMaterial', { color: '#4a9eff' })
     )
     \`\`\`
   - CORRECT FOR PRIMITIVE: Cache the actual THREE.js geometry instance, not the React element:
     \`\`\`
     const torusGeo = React.useMemo(() => new THREE.TorusGeometry(3, 0.4, 16, 50), []);
     React.createElement('primitive', { object: torusGeo })
     \`\`\`
   - REMEMBER: For mesh elements, geometry and material are ALWAYS children, NEVER props.
   - The ONLY element type that accepts a geometry prop is 'line', 'lineSegments', and 'points' (with a real BufferGeometry instance).
   - FIX: If you see cached React.createElement geometry elements being used as props or with primitive, either (1) put them as direct children of mesh, or (2) replace the createElement with \`new THREE.XxxGeometry(...)\` for use with primitive.

9. **"Rendered more hooks than during the previous render"** or **"Cannot read properties of undefined (reading 'length')"**
   - CAUSE: React hooks (useMemo, useRef, useEffect, useState) called INSIDE if/else, for/while blocks
   - React requires hooks to be called in the EXACT SAME ORDER every render. Conditional hooks break this rule.
   - WRONG:
     \`\`\`
     if (isBlackHole) {
       const geo = React.useMemo(() => { ... }, [dep]); // FATAL - hook inside if!
       children.push(React.createElement('line', { geometry: geo }));
     }
     \`\`\`
   - CORRECT:
     \`\`\`
     const geo = React.useMemo(() => { ... }, [dep]); // Hook at top level - ALWAYS runs
     if (isBlackHole) {
       children.push(React.createElement('line', { geometry: geo })); // Only render conditionally
     }
     \`\`\`
   - FIX: Move ALL React.useRef, React.useMemo, React.useEffect, React.useState calls to the TOP LEVEL of the code, before any if/for/while blocks. The results can then be used conditionally.

10. **"CustomCurve is not defined"** or **"[ClassName] is not defined"** (class definition errors)
   - CAUSE: Defining a class (e.g., extending THREE.Curve) INSIDE a React.useMemo or other hook callback
   - JavaScript class declarations inside functions don't hoist properly when the code is sandboxed
   - WRONG:
     \`\`\`
     const tubeGeo = React.useMemo(() => {
       class MyCurve extends THREE.Curve {
         getPoint(t) { return new THREE.Vector3(t, Math.sin(t), 0); }
       }
       return new THREE.TubeGeometry(new MyCurve(), 20, 0.4, 12, false);
     }, []);
     \`\`\`
   - CORRECT: Define the class at the TOP LEVEL, before all hooks:
     \`\`\`
     class MyCurve extends THREE.Curve {
       getPoint(t) { return new THREE.Vector3(t, Math.sin(t), 0); }
     }
     
     const tubeGeo = React.useMemo(() => {
       return new THREE.TubeGeometry(new MyCurve(), 20, 0.4, 12, false);
     }, []);
     \`\`\`
   - FIX: Move ALL class declarations to the top level of your code, before any React hooks or function definitions.

11. **"xxx.dispose is not a function"** (geometry dispose crash)
   - CAUSE: A React element object was assigned to \`.geometry\` instead of a real THREE.js geometry instance.
     This happens when a sanitizer or code generator wraps imperative geometry construction with React.createElement.
   - WRONG (assigns a React element, not a geometry):
     \`\`\`
     useFrame(() => {
       mesh.geometry.dispose();
       mesh.geometry = React.createElement('tubeGeometry', { args: [curve, 64, 0.5, 8, false] });
     });
     \`\`\`
   - CORRECT (assigns a real THREE.js geometry):
     \`\`\`
     useFrame(() => {
       mesh.geometry.dispose();
       mesh.geometry = new THREE.TubeGeometry(curve, 64, 0.5, 8, false);
     });
     \`\`\`
   - FIX: When assigning to \`.geometry\` imperatively (outside JSX), always use \`new THREE.XxxGeometry(...)\` directly. Do NOT wrap it in React.createElement — that produces a React element object, not a geometry.
`;

/**
 * Detect React hooks (useMemo, useRef, useEffect, useState, useCallback) that
 * are called inside conditional blocks (if/else, for, while) and hoist them to
 * the top level of the code. This prevents the fatal React error:
 *   "Rendered more hooks than during the previous render"
 *
 * Common AI-generated pattern (WRONG — crashes when condition changes):
 *   if (condition) {
 *     const geo = React.useMemo(() => { ... }, [dep]);
 *     children.push(React.createElement('line', { geometry: geo }));
 *   }
 *
 * Fixed output (CORRECT — hook always executes):
 *   const geo = React.useMemo(() => { ... }, [dep]);
 *   if (condition) {
 *     children.push(React.createElement('line', { geometry: geo }));
 *   }
 */
function hoistConditionalHooks(code: string): string {
  const hookNames = ['useMemo', 'useRef', 'useEffect', 'useState', 'useCallback'];

  let result = code;
  const hoistedStatements: string[] = [];
  let madeChange = true;
  let iterations = 0;

  while (madeChange && iterations < 30) {
    madeChange = false;
    iterations++;

    // Build brace-depth map. Track string literals to avoid counting braces inside them.
    const len = result.length;
    let depth = 0;
    let inStr: string | null = null;
    let escaped = false;
    const depthAt: number[] = new Array(len);

    for (let i = 0; i < len; i++) {
      if (escaped) { escaped = false; depthAt[i] = depth; continue; }
      const ch = result[i];
      if (ch === '\\' && inStr) { escaped = true; depthAt[i] = depth; continue; }
      if (inStr) {
        if (ch === inStr) inStr = null;
        depthAt[i] = depth;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') { inStr = ch; depthAt[i] = depth; continue; }
      if (ch === '{') { depth++; depthAt[i] = depth; continue; }
      if (ch === '}') { depth--; depthAt[i] = depth; continue; }
      depthAt[i] = depth;
    }

    // Scan for hook calls at brace depth > 0 (i.e. inside a block)
    for (const hookName of hookNames) {
      const search = `React.${hookName}(`;
      let pos = 0;

      while (pos < result.length) {
        const idx = result.indexOf(search, pos);
        if (idx === -1) break;

        if (depthAt[idx] > 0) {
          // Found a hook inside a block — extract and hoist to top level

          // Walk back to capture preceding `const/let/var varName = `
          let stmtStart = idx;
          const lookBack = result.substring(Math.max(0, idx - 120), idx);
          const declMatch = lookBack.match(/((?:const|let|var)\s+\w+\s*=\s*)$/);
          if (declMatch) {
            stmtStart = idx - declMatch[1].length;
          }

          // Walk forward balancing parens to find end of React.useXxx(...)
          const parenStart = idx + search.length - 1; // position of '('
          let parenDepth = 1;
          let endPos = parenStart + 1;
          let pInStr: string | null = null;
          let pEscaped = false;

          while (endPos < result.length && parenDepth > 0) {
            const c = result[endPos];
            if (pEscaped) { pEscaped = false; endPos++; continue; }
            if (c === '\\' && pInStr) { pEscaped = true; endPos++; continue; }
            if (pInStr) { if (c === pInStr) pInStr = null; endPos++; continue; }
            if (c === "'" || c === '"' || c === '`') { pInStr = c; endPos++; continue; }
            if (c === '(') parenDepth++;
            if (c === ')') {
              parenDepth--;
              if (parenDepth === 0) { endPos++; break; }
            }
            endPos++;
          }

          // Skip trailing semicolons, spaces, and one newline
          while (endPos < result.length && (result[endPos] === ';' || result[endPos] === ' ')) endPos++;
          if (endPos < result.length && result[endPos] === '\n') endPos++;

          // Extract and remove the statement from its conditional position
          const stmt = result.substring(stmtStart, endPos).trim();
          result = result.substring(0, stmtStart) + result.substring(endPos);

          hoistedStatements.push(stmt);
          madeChange = true;
          break; // Restart scan — positions have shifted
        }

        pos = idx + search.length;
      }

      if (madeChange) break; // Rebuild depth map with updated code
    }
  }

  if (hoistedStatements.length > 0) {
    console.warn(`[sanitizeSimulationCode] Hoisted ${hoistedStatements.length} hook(s) from conditional blocks to top level`);
    devLogger.logAutoFix(
      'hoist-conditional-hooks',
      `Hoisted ${hoistedStatements.length} hook(s): ${hoistedStatements.map(s => s.substring(0, 80)).join('; ')}`
    );
    return hoistedStatements.join('\n') + '\n\n' + result;
  }

  return result;
}

function sanitizeSimulationCode(code: string): string {
  let sanitized = code;

  // --- Strip redeclarations of wrapper-provided variables ---
  // ThreeSandbox wraps code with: const { React, THREE, useFrame, useThree, Text, params } = args;
  // AI sometimes redeclares these causing "Identifier 'X' has already been declared" errors.
  // Also strip import/export statements which are invalid in Function() constructor context.
  const PROVIDED_VARS = new Set(['React', 'THREE', 'useFrame', 'useThree', 'Text', 'params']);
  sanitized = sanitized.split('\n').map(line => {
    const trimmed = line.trim();

    // Remove import statements (invalid in Function constructor)
    if (trimmed.startsWith('import ')) {
      console.warn(`[sanitizeSimulationCode] Removed import: ${trimmed.substring(0, 80)}`);
      devLogger.logAutoFix('strip-import', `Removed: ${trimmed.substring(0, 80)}`);
      return '';
    }

    // Strip export keywords (invalid in Function constructor): export default ..., export const ...
    if (trimmed.startsWith('export default ') || trimmed.startsWith('export ')) {
      const stripped = trimmed.replace(/^export\s+default\s+/, '').replace(/^export\s+/, '');
      console.warn(`[sanitizeSimulationCode] Stripped export keyword: ${trimmed.substring(0, 60)}`);
      devLogger.logAutoFix('strip-export', `Stripped export from: ${trimmed.substring(0, 60)}`);
      return line.replace(trimmed, stripped);
    }

    // Rename function declarations that shadow provided variables
    // Pattern: function useFrame(...) { ... } → function _shadow_useFrame(...) { ... }
    // We rename instead of removing because the body may span multiple lines.
    // Calls to useFrame() will correctly use the wrapper-provided version.
    const funcDeclMatch = trimmed.match(/^function\s+(\w+)\s*\(/);
    if (funcDeclMatch && PROVIDED_VARS.has(funcDeclMatch[1])) {
      const name = funcDeclMatch[1];
      console.warn(`[sanitizeSimulationCode] Renamed function shadowing provided var: ${name}`);
      devLogger.logAutoFix('rename-func-shadow', `Renamed: function ${name} → function _shadow_${name}`);
      return line.replace(`function ${name}`, `function _shadow_${name}`);
    }

    // Handle destructuring: const { useFrame, customHook } = obj
    const destructureMatch = trimmed.match(/^((?:const|let|var)\s+)\{([^}]+)\}(\s*=\s*.+)$/);
    if (destructureMatch) {
      const keyword = destructureMatch[1];        // "const "
      const namesStr = destructureMatch[2];        // "useFrame, customHook"
      const rhs = destructureMatch[3];             // " = obj;"
      const names = namesStr.split(',').map(s => s.trim()).filter(s => s.length > 0);
      const conflicting = names.filter(n => PROVIDED_VARS.has(n.split(/[\s:]/)[0].trim()));

      if (conflicting.length > 0) {
        const remaining = names.filter(n => !PROVIDED_VARS.has(n.split(/[\s:]/)[0].trim()));
        if (remaining.length === 0) {
          // ALL names are provided vars — remove entire line
          console.warn(`[sanitizeSimulationCode] Removed redeclaration: ${trimmed.substring(0, 80)}`);
          devLogger.logAutoFix('strip-redeclaration', `Removed: ${trimmed.substring(0, 80)}`);
          return '';
        } else {
          // Partial overlap — keep only non-provided names
          const newLine = `${keyword}{ ${remaining.join(', ')} }${rhs}`;
          console.warn(`[sanitizeSimulationCode] Stripped provided vars from destructuring: ${conflicting.join(', ')}`);
          devLogger.logAutoFix('strip-partial-redecl', `Removed ${conflicting.join(', ')} from destructuring`);
          return newLine;
        }
      }
    }

    // Handle direct variable redeclarations: const useFrame = ..., let THREE = ..., var React = ...
    const directDeclMatch = trimmed.match(/^(?:const|let|var)\s+(\w+)\s*=/);
    if (directDeclMatch && PROVIDED_VARS.has(directDeclMatch[1])) {
      console.warn(`[sanitizeSimulationCode] Removed direct redeclaration: ${trimmed.substring(0, 80)}`);
      devLogger.logAutoFix('strip-direct-redecl', `Removed: ${trimmed.substring(0, 80)}`);
      return '';
    }

    return line;
  }).join('\n');

  // --- Hoist hooks out of conditional blocks (if/for/while) to prevent ---
  // "Rendered more hooks than during the previous render" crashes.
  sanitized = hoistConditionalHooks(sanitized);

  // --- Replace Unicode superscripts/subscripts with plain ASCII ---
  // These characters cannot be rendered by troika-3d-text (drei Text) and
  // appear as box (☒) placeholders. Safe to replace globally since they should
  // never appear in JavaScript syntax — only in string literals.
  const unicodeBefore = sanitized;
  sanitized = sanitized.replace(UNICODE_REPLACE_RE, (ch) => UNICODE_TO_ASCII[ch] || ch);
  if (sanitized !== unicodeBefore) {
    const replacedCount = [...unicodeBefore].filter(ch => UNICODE_TO_ASCII[ch]).length;
    console.warn(`[sanitizeSimulationCode] Replaced ${replacedCount} Unicode sub/superscript character(s) with ASCII`);
    devLogger.logAutoFix('unicode-to-ascii', `Replaced ${replacedCount} Unicode sub/superscript character(s)`);
  }

  // --- Fix geometry constructors (skip BufferGeometry / Float32BufferAttribute) ---
  // Only convert `new THREE.XxxGeometry(...)` → `React.createElement(...)` when it
  // appears directly inline (e.g. as a child argument to createElement).
  //
  // If the geometry is being *stored* (variable assignment, arrow return, explicit
  // return, imperative .geometry assignment), leave it alone — converting would
  // produce a frozen React element instead of a real THREE.BufferGeometry, breaking
  // instancedMesh args, <primitive object={}>, .dispose(), etc.
  //
  // ThreeSandbox's runtime safeCreateElement auto-fix handles the remaining case
  // where an unconverted geometry instance is passed as a React child.

  for (const geo of R3F_GEOMETRY_TYPES) {
    const elementName = geo.charAt(0).toLowerCase() + geo.slice(1);
    const prefix = `new THREE.${geo}(`;
    let startIdx = 0;
    while (true) {
      const idx = sanitized.indexOf(prefix, startIdx);
      if (idx === -1) break;

      // Find the matching closing paren (balanced-paren counter)
      const argsStart = idx + prefix.length;
      let depth = 1;
      let i = argsStart;
      while (i < sanitized.length && depth > 0) {
        if (sanitized[i] === '(') depth++;
        else if (sanitized[i] === ')') depth--;
        i++;
      }
      const argsEnd = i - 1;
      const argsStr = sanitized.substring(argsStart, argsEnd).trim();

      // Check the code immediately before `new THREE.XxxGeometry(` to decide
      // whether this geometry is being stored/returned (skip) or used inline (convert).
      const lookBack = sanitized.substring(Math.max(0, idx - 80), idx);
      const isAssignment = /=\s*$/.test(lookBack);       // const x = ..., .geometry = ...
      const isArrowReturn = /=>\s*$/.test(lookBack);     // () => new THREE...
      const isExplicitReturn = /return\s+$/.test(lookBack); // return new THREE...

      if (isAssignment || isArrowReturn || isExplicitReturn) {
        console.log(`[sanitizeSimulationCode] Skipped: new THREE.${geo}(...) — stored/returned, not inline`);
        startIdx = argsEnd + 1;
        continue;
      }

      let replacement: string;
      if (argsStr.length === 0) {
        replacement = `React.createElement('${elementName}')`;
      } else {
        replacement = `React.createElement('${elementName}', { args: [${argsStr}] })`;
      }

      console.warn(`[sanitizeSimulationCode] Replaced: new THREE.${geo}(...) -> React.createElement('${elementName}', ...)`);
      devLogger.logAutoFix('sanitize-geometry', `new THREE.${geo}(...) -> React.createElement('${elementName}', ...)`);
      sanitized = sanitized.substring(0, idx) + replacement + sanitized.substring(argsEnd + 1);
      startIdx = idx + replacement.length;
    }
  }

  // --- Fix React.createElement('xxxGeometry', ...) with method calls ---
  // AI sometimes writes: const geo = React.createElement('planeGeometry', { args: [...] }); geo.rotateX(...)
  // React.createElement returns a React element, NOT a geometry. Convert back to THREE constructor.
  const GEOMETRY_INSTANCE_METHODS = [
    'rotateX', 'rotateY', 'rotateZ', 'translate', 'scale', 'lookAt',
    'setAttribute', 'setIndex', 'setFromPoints', 'computeVertexNormals',
    'computeBoundingSphere', 'computeBoundingBox', 'center', 'normalize',
    'applyMatrix4', 'merge', 'dispose', 'clone', 'copy',
    'attributes', 'index',
  ];
  for (const geo of R3F_GEOMETRY_TYPES) {
    const elementName = geo.charAt(0).toLowerCase() + geo.slice(1);
    const cePattern = `React.createElement('${elementName}'`;
    let searchStart = 0;
    while (true) {
      const ceIdx = sanitized.indexOf(cePattern, searchStart);
      if (ceIdx === -1) break;

      // Check if this is assigned to a variable
      const lookBack = sanitized.substring(Math.max(0, ceIdx - 80), ceIdx);
      const varMatch = lookBack.match(/(?:const|let|var)\s+(\w+)\s*=\s*$/);
      if (!varMatch) { searchStart = ceIdx + cePattern.length; continue; }

      const varName = varMatch[1];
      const codeAfter = sanitized.substring(ceIdx);

      // Check if geometry methods are called on this variable
      let needsFix = false;
      for (const method of GEOMETRY_INSTANCE_METHODS) {
        if (codeAfter.includes(`${varName}.${method}`)) {
          needsFix = true;
          break;
        }
      }
      if (!needsFix) { searchStart = ceIdx + cePattern.length; continue; }

      // Extract args from React.createElement('xxxGeometry', { args: [...] })
      // Find closing paren
      const parenStart = ceIdx + cePattern.length;
      let depth = 1;
      let pIdx = parenStart;
      // We need to find the outer closing paren of createElement(...)
      // First find the opening paren
      const openParen = sanitized.indexOf('(', ceIdx);
      if (openParen === -1) { searchStart = ceIdx + cePattern.length; continue; }
      pIdx = openParen + 1;
      depth = 1;
      while (pIdx < sanitized.length && depth > 0) {
        if (sanitized[pIdx] === '(') depth++;
        else if (sanitized[pIdx] === ')') depth--;
        pIdx++;
      }
      const fullCall = sanitized.substring(ceIdx, pIdx);

      // Try to extract args array from { args: [...] }
      const argsMatch = fullCall.match(/\{\s*args:\s*\[([^\]]*)\]\s*\}/);
      let replacement: string;
      if (argsMatch) {
        replacement = `new THREE.${geo}(${argsMatch[1]})`;
      } else {
        replacement = `new THREE.${geo}()`;
      }

      console.warn(`[sanitizeSimulationCode] Fixed: React.createElement('${elementName}', ...) -> new THREE.${geo}(...) (variable '${varName}' has geometry methods)`);
      devLogger.logAutoFix('fix-createElement-geometry', `React.createElement('${elementName}', ...) -> new THREE.${geo}(...) for variable '${varName}'`);
      sanitized = sanitized.substring(0, ceIdx) + replacement + sanitized.substring(pIdx);
      searchStart = ceIdx + replacement.length;
    }
  }

  // --- Fix .current.setFromPoints() called on non-BufferGeometry refs ---
  // Common AI mistake: ref on a <line> element, then calling ref.current.setFromPoints(...)
  // The correct call is ref.current.geometry.setFromPoints(...) because the ref points to
  // a THREE.Line, not a THREE.BufferGeometry.
  // Fix: someRef.current.setFromPoints(...) → (someRef.current.geometry || someRef.current).setFromPoints(...)
  // This safely handles both cases:
  //   - If ref IS a BufferGeometry: .geometry is undefined → fallback to ref.current ✓
  //   - If ref IS a Line/Points: .geometry IS the BufferGeometry → uses that ✓
  sanitized = sanitized.replace(
    /(\w+(?:\.\w+)*\.current)\.setFromPoints\(/g,
    '($1.geometry || $1).setFromPoints('
  );

  // --- Remove .computeBoundingSphere() calls that crash at runtime ---
  // The AI sometimes calls computeBoundingSphere() on BufferAttribute objects
  // (e.g. `attr.computeBoundingSphere()`) instead of on the BufferGeometry.
  // Since we set frustumCulled=false on all 3D elements, these calls are
  // unnecessary. Strip them entirely to prevent "is not a function" errors.
  // Matches patterns like:
  //   attr.computeBoundingSphere()
  //   someRef.current.geometry.attributes.position.computeBoundingSphere()
  //   geo.computeBoundingSphere()
  // Replaces the entire statement (including trailing semicolon/newline) with nothing.
  const cbsBefore = sanitized;
  sanitized = sanitized.replace(
    /\b\w+(?:\.\w+)*\.computeBoundingSphere\(\s*\)\s*;?/g,
    '/* computeBoundingSphere removed - frustumCulled:false handles this */'
  );
  if (sanitized !== cbsBefore) {
    const removedCount = (cbsBefore.match(/\.computeBoundingSphere\(/g) || []).length;
    console.warn(`[sanitizeSimulationCode] Removed ${removedCount} .computeBoundingSphere() call(s) (frustumCulled:false is set)`);
    devLogger.logAutoFix('remove-computeBoundingSphere', `Removed ${removedCount} .computeBoundingSphere() call(s)`);
  }

  // --- Detect multi-object animation anti-pattern ---
  // Pattern: rocketsRef.current.map/forEach in return statement with position: [ref.pos.x, ...]
  // This causes laggy animation because position prop only evaluates once per render.
  // The correct pattern is to pre-allocate mesh refs and update mesh.position in useFrame.
  const multiObjAntiPattern = /(\w+Ref\.current(?:\.\w+)*)\.(?:map|forEach)\([^)]*=>\s*React\.createElement\(['"]mesh['"],\s*\{[^}]*position:\s*\[[^\]]*\1\[.*?\]\.(?:pos|position)/;
  if (multiObjAntiPattern.test(sanitized)) {
    console.warn('[sanitizeSimulationCode] ⚠️  ANIMATION BUG DETECTED: Multi-object animation using position prop from ref array. This causes laggy/glitchy animation. Use pre-allocated mesh refs and update mesh.position in useFrame instead. See section 7b of the prompt.');
    devLogger.addEntry('warn', 'Sanitizer', 'Multi-object animation anti-pattern detected: position prop from ref array will not animate smoothly');
  }

  // --- Fix material constructors ---
  for (const mat of R3F_MATERIAL_TYPES) {
    const elementName = mat.charAt(0).toLowerCase() + mat.slice(1);
    const prefix = `new THREE.${mat}(`;
    let startIdx = 0;
    while (true) {
      const idx = sanitized.indexOf(prefix, startIdx);
      if (idx === -1) break;

      const argsStart = idx + prefix.length;
      let depth = 1;
      let i = argsStart;
      while (i < sanitized.length && depth > 0) {
        if (sanitized[i] === '(') depth++;
        else if (sanitized[i] === ')') depth--;
        i++;
      }
      const argsEnd = i - 1;
      const argsStr = sanitized.substring(argsStart, argsEnd).trim();

      let replacement: string;
      if (argsStr.length === 0) {
        replacement = `React.createElement('${elementName}')`;
      } else {
        // Materials take an object arg: new THREE.MeshStandardMaterial({ color: 'red' })
        // The argsStr is typically `{ color: 'red' }` — we unwrap the outer braces for R3F props
        const unwrapped = argsStr.replace(/^\{/, '').replace(/\}$/, '').trim();
        if (unwrapped.length > 0) {
          replacement = `React.createElement('${elementName}', { ${unwrapped} })`;
        } else {
          replacement = `React.createElement('${elementName}')`;
        }
      }

      console.warn(`[sanitizeSimulationCode] Replaced: new THREE.${mat}(...) -> React.createElement('${elementName}', ...)`);
      devLogger.logAutoFix('sanitize-material', `new THREE.${mat}(...) -> React.createElement('${elementName}', ...)`);
      sanitized = sanitized.substring(0, idx) + replacement + sanitized.substring(argsEnd + 1);
      startIdx = idx + replacement.length;
    }
  }

  return sanitized;
}

// ============================================================================
// Gemini API Call Function
// ============================================================================

async function callGemini(
  messages: Array<{role: string, content: string}>, 
  schema: any, 
  schemaName: string, 
  model: string = "gemini-3-flash-preview"
) {
  // Sanitize schema for Gemini compatibility
  const geminiSchema = sanitizeSchemaForGemini(schema);
  
  // Gemini uses "contents" with "parts" structure
  // System instructions are passed separately
  const systemMessage = messages.find(m => m.role === 'system');
  const userMessages = messages.filter(m => m.role !== 'system');
  
  // Build Gemini request body
  const requestBody: any = {
    contents: userMessages.map(msg => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }]
    })),
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: geminiSchema
    }
  };
  
  // Add system instruction if present
  if (systemMessage) {
    requestBody.systemInstruction = {
      parts: [{ text: systemMessage.content }]
    };
  }
  
  const response = await fetch(`${GEMINI_API_URL}/${model}:generateContent?key=${GEMINI_API_KEY}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Gemini API error: ${response.status} - ${error}`);
  }

  const data = await response.json();
  
  // Extract text from Gemini response structure
  const textContent = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!textContent) {
    throw new Error('Gemini API returned empty response');
  }
  
  const result = JSON.parse(textContent);
  
  return result;
}

// ============================================================================
// Unified API Call Function
// ============================================================================

// ============================================================================
// Session-Level API Budget (Circuit Breaker)
// ============================================================================
// Hard cap on error-correction LLM calls per browser session.  Prevents any
// runaway retry loop — regardless of cause — from burning thousands of API
// calls and tokens.  Normal content generation (slides, quiz, sim gen, chat)
// is NOT counted; only error-fix / retry paths increment the budget.
// ============================================================================
const ERROR_CORRECTION_BUDGET = {
  /** Max error-correction calls allowed per session (set dynamically to section count) */
  maxCalls: 5,
  /** Calls consumed so far in this session */
  callsUsed: 0,
  /** Per-section caps: sectionId → calls used */
  perSection: new Map<number, number>(),
  /** Max error-correction calls per individual section — 1 means one shot per section */
  maxPerSection: 1,
};

/**
 * Set the session budget to match the number of sections in the course.
 * Called once after syllabus generation so that maxCalls = sectionCount
 * (i.e., at most 1 error-correction call per section across the session).
 */
export function initErrorCorrectionBudget(sectionCount: number): void {
  ERROR_CORRECTION_BUDGET.maxCalls = sectionCount;
  ERROR_CORRECTION_BUDGET.callsUsed = 0;
  ERROR_CORRECTION_BUDGET.perSection.clear();
  console.log(`[BUDGET] Initialized: ${sectionCount} sections → max ${sectionCount} error-correction calls (1 per section)`);
}

/**
 * Check whether an error-correction call is allowed.  If over budget, throws
 * so the caller's catch block can handle it gracefully.
 */
export function consumeErrorCorrectionBudget(sectionId?: number): void {
  if (sectionId !== undefined) {
    const prev = ERROR_CORRECTION_BUDGET.perSection.get(sectionId) ?? 0;
    if (prev >= ERROR_CORRECTION_BUDGET.maxPerSection) {
      const msg = `[BUDGET] Section ${sectionId}: already used ${prev}/${ERROR_CORRECTION_BUDGET.maxPerSection} error-correction call(s). Giving up on this section.`;
      console.warn(msg);
      devLogger.addEntry('warn', 'Budget', msg);
      throw new Error(msg);
    }
    ERROR_CORRECTION_BUDGET.perSection.set(sectionId, prev + 1);
  }

  ERROR_CORRECTION_BUDGET.callsUsed++;
  if (ERROR_CORRECTION_BUDGET.callsUsed > ERROR_CORRECTION_BUDGET.maxCalls) {
    const msg = `[BUDGET] Session limit reached (${ERROR_CORRECTION_BUDGET.callsUsed}/${ERROR_CORRECTION_BUDGET.maxCalls}). No more retries this session.`;
    console.warn(msg);
    devLogger.addEntry('warn', 'Budget', msg);
    throw new Error(msg);
  }

  console.log(`[BUDGET] Error-correction call ${ERROR_CORRECTION_BUDGET.callsUsed}/${ERROR_CORRECTION_BUDGET.maxCalls} (section ${sectionId ?? '?'})`);
}

async function callLLM(
  messages: Array<{role: string, content: string}>,
  schema: any,
  schemaName: string,
  modelTier: ModelTier = 'fast'
) {
  const model = getModel(modelTier);

  console.log(`[LLM] Using Gemini with model ${model}`);

  return callGemini(messages, schema, schemaName, model);
}

// Build rich context from previous sections (FULL content, not just titles)
export const buildRichPreviousContext = (
  previousSectionsContent: Array<{
    id: number;
    title: string;
    content: SectionContent;
  }>
): string => {
  if (previousSectionsContent.length === 0) {
    return "This is the first section of the course. No previous content.";
  }

  return previousSectionsContent.map(section => {
    let contextText = `\n${'='.repeat(60)}\nSECTION ${section.id}: ${section.title}\n${'='.repeat(60)}\n`;

    // Full slide content
    contextText += `\n--- SLIDES CONTENT ---\n`;
    section.content.slides.forEach((slide, idx) => {
      contextText += `\nSlide ${idx + 1}: ${slide.title}\n`;
      // Strip HTML tags for cleaner context but keep the substance
      const cleanContent = slide.content.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      contextText += `Content: ${cleanContent}\n`;
    });

    // Full quiz questions and answers
    if (section.content.quiz && section.content.quiz.length > 0) {
      contextText += `\n--- QUIZ QUESTIONS & ANSWERS ---\n`;
      section.content.quiz.forEach((q, idx) => {
        contextText += `Q${idx + 1}: ${q.question}\n`;
        contextText += `Options: ${q.options.join(' | ')}\n`;
        contextText += `Correct Answer: ${q.options[q.correctAnswerIndex]}\n\n`;
      });
    }

    // Full simulation description and params
    if (section.content.interactiveConfig) {
      contextText += `\n--- 3D SIMULATION ---\n`;
      contextText += `Description: ${section.content.interactiveConfig.prompt}\n`;
      contextText += `Interactive Parameters:\n`;
      section.content.interactiveConfig.params.forEach(p => {
        contextText += `  - ${p.label} (${p.controlType}): ${p.min} to ${p.max}\n`;
      });
    }

    return contextText;
  }).join('\n');
};

// Progress callback type for tracking generation steps
export type GenerationStep = 'slides' | 'voice' | 'simulation' | 'quiz';
export type ProgressCallback = (step: GenerationStep, status: 'pending' | 'in-progress' | 'complete') => void;

// Generate level-specific instructions for prompts
export const getLevelInstructions = (level: LearningLevel): string => {
  const instructions: Record<LearningLevel, string> = {
    beginner: `
TARGET AUDIENCE: Beginners (Ages 10-14, Middle School level)

CONTENT GUIDELINES:
- Use SIMPLE, everyday language. Avoid jargon and technical terms.
- Explain concepts using relatable analogies and real-world examples.
- Mathematics: Use only BASIC ARITHMETIC (addition, subtraction, multiplication, division). NO algebra, NO formulas with variables.
- Focus on "What is it?" and "Why is it interesting?" rather than "How does the math work?"
- Make it FUN and engaging - use exciting examples, interesting facts.
- Simulations should be playful and exploratory - let them discover through interaction.
- Keep explanations SHORT and VISUAL. Use bullet points over paragraphs.
- Example tone: "A pendulum is like a swing at the playground - it goes back and forth!"
`,
    highschool: `
TARGET AUDIENCE: High School Students (Ages 14-18)

CONTENT GUIDELINES:
- Use standard academic language appropriate for high school.
- Introduce and explain technical terms when first used.
- Mathematics: Use ALGEBRA and BASIC TRIGONOMETRY. Include key formulas but explain each variable.
- Cover the "standard curriculum" depth - what would be taught in a good high school physics/chemistry/biology class.
- Balance theory with practical applications.
- Simulations should demonstrate key principles and allow experimentation with variables.
- Example formulas OK: T = 2π√(L/g), F = ma, v = d/t
- Example tone: "The period of a pendulum depends on its length and gravity. Let's explore the formula..."
`,
    undergraduate: `
TARGET AUDIENCE: Undergraduate/College Students

CONTENT GUIDELINES:
- Use proper scientific/academic language and notation.
- Assume familiarity with basic concepts - focus on deeper understanding.
- Mathematics: Use CALCULUS and DIFFERENTIAL EQUATIONS freely. Show full derivations.
- Derive formulas from first principles where appropriate.
- Discuss theoretical foundations, assumptions, and limitations.
- Simulations should visualize complex phenomena and mathematical relationships.
- Include edge cases, special conditions, and extensions.
- Example depth: Deriving equations of motion using Lagrangian mechanics, discussing small-angle approximation and its validity.
- Example tone: "Applying the Euler-Lagrange equation to the pendulum system..."
`,
    graduate: `
TARGET AUDIENCE: Graduate/Postgraduate Level (Advanced/Research)

CONTENT GUIDELINES:
- Use advanced scientific terminology and mathematical rigor.
- Assume strong background in the field - focus on advanced topics.
- Mathematics: Use ADVANCED MATHEMATICS - tensors, partial differential equations, advanced proofs, numerical methods.
- Discuss cutting-edge research, open problems, and specialized applications.
- Cover nonlinear effects, coupled systems, perturbation methods, chaos theory where relevant.
- Simulations should demonstrate sophisticated phenomena, numerical solutions, phase spaces.
- Include references to research-level concepts and methods.
- Don't oversimplify - your audience can handle complexity.
- Example depth: Nonlinear dynamics, stability analysis, bifurcations, Lyapunov exponents.
- Example tone: "The double pendulum exhibits chaotic behavior - let's examine the phase space structure..."
`
  };
  
  return instructions[level];
};

// Build syllabus context showing ALL sections (so LLM knows what's coming)
export const buildSyllabusContext = (
  sections: Array<{ id: number; title: string; description: string }>,
  currentSectionId: number
): string => {
  return sections.map(s => {
    const marker = s.id === currentSectionId ? '→ [CURRENT]' : 
                   s.id < currentSectionId ? '[COMPLETED]' : '[UPCOMING]';
    return `Section ${s.id} ${marker}: ${s.title}\n   ${s.description}`;
  }).join('\n\n');
};

// Helper to orchestrate the generation of all content for a section
// Flow: Slides → (Voice + Simulation in parallel) → Quiz
export const fetchFullSectionData = async (
  topic: string,
  sectionTitle: string,
  previousContext: string,
  sectionNumber: number,
  onProgress?: ProgressCallback,
  syllabusContext?: string,  // Full syllabus so LLM knows course structure
  level: LearningLevel = 'highschool',  // Learning level for content complexity
  onSlidesReady?: (slides: Slide[]) => void,  // Callback when slides are ready (for early fullscreen view)
  onSlideVoiceReady?: (slideIndex: number, speakerNotes: string, audioData: string) => void,  // Callback when a single slide's voice is ready
  enableVoice: boolean = true  // When false, skip voice generation entirely
): Promise<SectionContent> => {
  console.log(`[GeminiService] Generating Section ${sectionNumber}: ${sectionTitle} (Level: ${level}, Voice: ${enableVoice})`);
  
  // 1. Generate Slides (without voice — voice is generated in background)
  onProgress?.('slides', 'in-progress');
  console.log(`  [Step 1] Generating slides...`);
  
  const contentData = await generateSectionContent(topic, sectionTitle, previousContext, sectionNumber, syllabusContext, level);
  console.log(`    - Generated ${contentData.slides.length} slides`);
  
  // Slides are ready immediately — notify the UI so they can be viewed right away
  onProgress?.('slides', 'complete');
  console.log(`  [Step 1] Complete: ${contentData.slides.length} slides ready`);
  onSlidesReady?.(contentData.slides);

  // Build context from slides for other generations
  const currentSlidesContext = contentData.slides.map((slide, idx) => {
    const cleanContent = slide.content.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    return `Slide ${idx + 1} - ${slide.title}: ${cleanContent}`;
  }).join('\n\n');

  // 2. Voice narration (optional) + 3D Simulation in PARALLEL
  //    Voice generates sequentially per slide but runs alongside simulation.
  //    Each slide's voice notifies the UI incrementally via onSlideVoiceReady.

  // --- Voice generation (background, incremental) — only if enabled ---
  const voicePromise = enableVoice
    ? (async () => {
        onProgress?.('voice', 'in-progress');
        console.log(`  [Step 2a] Generating voice narration in background...`);
        const slidesWithNarration: Slide[] = [];
        for (let idx = 0; idx < contentData.slides.length; idx++) {
          const slide = contentData.slides[idx];
          try {
            console.log(`    - Generating voice for slide ${idx + 1}/${contentData.slides.length}: "${slide.title}"`);
            
            const speakerNotes = await generateSpeakerNotes(
              slide.title,
              slide.content,
              topic,
              level
            );
            
            const audioData = await generateSpeechAudio(speakerNotes, 'Charon');
            
            slidesWithNarration.push({ ...slide, speakerNotes, audioData });
            console.log(`    - Voice ready for slide ${idx + 1}`);
            
            // Notify UI so this slide's voice is available immediately
            onSlideVoiceReady?.(idx, speakerNotes, audioData);
          } catch (error) {
            console.error(`    - Error generating voice for slide ${idx + 1}:`, error);
            slidesWithNarration.push(slide);
          }
        }
        onProgress?.('voice', 'complete');
        console.log(`  [Step 2a] Complete: voice narration for ${slidesWithNarration.length} slides`);
        return slidesWithNarration;
      })()
    : (async () => {
        console.log(`  [Step 2a] Voice narration skipped (disabled by user)`);
        return contentData.slides; // Return slides without narration
      })();

  // Serialize the structured simulation blueprint into a rich text description for the code generator
  const blueprint = contentData.interactivePrompt;
  const serializedBlueprint = [
    `OVERVIEW: ${blueprint.overview}`,
    `\nVISUAL LAYERS (compose these as distinct systems):`,
    ...(blueprint.visualLayers || []).map((layer: string, i: number) => `  ${i + 1}. ${layer}`),
    `\nPHYSICS MODEL: ${blueprint.physicsModel}`,
    `\nPARAMETER DRAMA (each control must create dramatic visual change):`,
    ...(blueprint.parameterDrama || []).map((p: string) => `  - ${p}`),
    `\nREQUIRED VISUAL TECHNIQUES: ${(blueprint.visualTechniques || []).join(', ')}`
  ].join('\n');

  // --- 3D Simulation generation (parallel with voice) ---
  const simulationPromise = (async () => {
    onProgress?.('simulation', 'in-progress');
    console.log(`  [Step 2b] Generating 3D simulation...`);
    const interactiveData = await generateInteractiveCode(
      topic, 
      sectionTitle, 
      serializedBlueprint, 
      previousContext,
      currentSlidesContext,
      sectionNumber,
      level
    );
    onProgress?.('simulation', 'complete');
    console.log(`  [Step 2b] Complete: 3D simulation ready`);
    return interactiveData;
  })();

  // Wait for both voice (if enabled) and simulation to finish
  const [slidesWithNarration, interactiveData] = await Promise.all([voicePromise, simulationPromise]);

  // Build context from interactive config for quiz
  const interactiveContext = `
3D Simulation Description: ${serializedBlueprint}
Interactive Controls: ${interactiveData.params.map(p => `${p.label} (${p.controlType})`).join(', ')}
  `.trim();

  // 3. Generate Quiz (needs simulation context)
  onProgress?.('quiz', 'in-progress');
  console.log(`  [Step 3] Generating quiz...`);
  const quizData = await generateQuiz(
    topic, 
    sectionTitle, 
    previousContext,
    currentSlidesContext,
    interactiveContext,
    sectionNumber,
    level
  );
  onProgress?.('quiz', 'complete');
  console.log(`  [Step 3] Complete: Quiz ready`);

  console.log(`[GeminiService] Section ${sectionNumber} fully complete!`);

  return {
    slides: slidesWithNarration,
    interactiveConfig: interactiveData,
    quiz: quizData
  };
};

// Max characters of source document to send to the model (stay within context limits)
const MAX_SOURCE_DOCUMENT_CHARS = 18_000;

// 1. Generate Syllabus
export const generateSyllabus = async (
  topic: string,
  level: LearningLevel,
  sourceDocument?: string
): Promise<Section[]> => {
  const schema = {
    type: "object",
    properties: {
      sections: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "integer" },
            title: { type: "string", description: "Short, clear section title (5-10 words max)" },
            description: { type: "string", description: "Brief 1-2 sentence description (max 30 words). Just summarize what students will learn, don't list all topics." },
          },
          required: ["id", "title", "description"],
          additionalProperties: false,
        },
      },
    },
    required: ["sections"],
    additionalProperties: false,
  };

  const levelInstructions = getLevelInstructions(level);

  const userContent = sourceDocument
    ? (() => {
        const truncated =
          sourceDocument.length > MAX_SOURCE_DOCUMENT_CHARS
            ? sourceDocument.slice(0, MAX_SOURCE_DOCUMENT_CHARS) + "\n\n[… document truncated for length]"
            : sourceDocument;
        return `Create a structured educational syllabus BASED ON the following document. Use this as the primary source. The course topic/title is: "${topic}".

Divide the document content into 4-5 progressive sections appropriate for the specified learning level.
Ensure the flow is logical (e.g., Intro -> Basic Concepts -> Application -> Advanced).
Base section titles and descriptions on the actual content of the document.

--- DOCUMENT CONTENT ---

${truncated}

--- END DOCUMENT ---

CRITICAL - KEEP DESCRIPTIONS SHORT:
- Title: 5-10 words max
- Description: 1-2 sentences ONLY (max 30 words)
- DO NOT list every sub-topic or detail
- DO NOT include "Goal:", "Content:", "Derivations:" prefixes
- Just write a simple, friendly summary

Each section will have an interactive 3D simulation built for it.
Remember: Match the complexity and depth to the TARGET AUDIENCE specified in the system prompt.`;
      })()
    : `Create a structured educational syllabus for the topic: "${topic}".

Divide it into 4-5 progressive sections appropriate for the specified learning level.
Ensure the flow is logical (e.g., Intro -> Basic Concepts -> Application -> Advanced).

CRITICAL - KEEP DESCRIPTIONS SHORT:
- Title: 5-10 words max
- Description: 1-2 sentences ONLY (max 30 words)
- DO NOT list every sub-topic or detail
- DO NOT include "Goal:", "Content:", "Derivations:" prefixes
- Just write a simple, friendly summary

GOOD EXAMPLE:
- Title: "Understanding Pendulum Motion"
- Description: "Explore how pendulums swing and what affects their speed. Watch a 3D pendulum respond to your inputs."

BAD EXAMPLE (TOO LONG):
- Description: "Goal: Build geometric and analytical intuition... Content: brief historical context, fixed-point interpretation... Derivations: derive the update from..."

Each section will have an interactive 3D simulation built for it.
Remember: Match the complexity and depth to the TARGET AUDIENCE specified in the system prompt.`;

  const messages = [
    {
      role: "system",
      content: `You are an expert curriculum designer for an INTERACTIVE 3D LEARNING PLATFORM.

${levelInstructions}

CRITICAL CONTEXT:
This platform teaches concepts through a combination of:
1. Educational slides (text-based explanations)
2. Interactive 3D simulations (Three.js/WebGL visualizations) for EACH section
3. Quizzes to test understanding

IMPORTANT: Each section MUST have a meaningful 3D simulation component.
- Design sections around concepts that CAN BE VISUALIZED in 3D
- Good simulation candidates: physics (motion, forces, waves), chemistry (molecular structures, reactions), math (geometry, graphs, transformations), biology (cell structures, systems), astronomy (orbits, planetary systems), engineering (circuits, mechanisms)
- Avoid sections that are purely definitional, historical, or abstract without visual analogies
- If a topic has limited visual aspects, focus sections on the parts that CAN be demonstrated visually

When designing sections, think: "What 3D interactive experience would help students understand this?"
If you can't imagine a compelling simulation for a section, restructure the content.

CRITICAL: Design the syllabus depth and complexity to match the TARGET AUDIENCE level specified above.
- For beginners: Keep it simple, fun, and exploratory
- For high school: Cover standard curriculum topics
- For undergraduate: Include theoretical depth
- For graduate: Include advanced/specialized topics`
    },
    {
      role: "user",
      content: userContent
    }
  ];

  const data = await callLLM(messages, schema, "syllabus_schema", "fast");
  
  return data.sections.map((item: any) => ({
    ...item,
    isLocked: item.id !== 1,
    isCompleted: false,
  }));
};

// 2. Generate Slides & Interactive Prompt Definition
export const generateSectionContent = async (
  topic: string,
  sectionTitle: string,
  previousContext: string,
  sectionNumber: number,
  syllabusContext?: string,  // Full syllabus for scope awareness
  level: LearningLevel = 'highschool'  // Learning level
): Promise<{ slides: Slide[], interactivePrompt: { overview: string; visualLayers: string[]; physicsModel: string; parameterDrama: string[]; visualTechniques: string[] } }> => {
  const schema = {
    type: "object",
    properties: {
      slides: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            content: { type: "string", description: "Raw HTML content using Tailwind CSS classes. Use LaTeX ($...$ or $$...$$) for math." },
            backgroundColor: { 
              type: "string", 
              description: "Hex color for slide background (e.g., '#1C2833'). Choose colors that match the topic and ensure text contrast. If backgroundGradient is provided, this is ignored.",
              pattern: "^#[0-9A-Fa-f]{6}$"
            },
            backgroundGradient: {
              type: "object",
              description: "Optional gradient background. If provided, backgroundColor is ignored. Use for more dynamic visual interest.",
              properties: {
                type: { type: "string", enum: ["linear", "radial"] },
                colors: { 
                  type: "array", 
                  items: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" },
                  minItems: 2,
                  maxItems: 4,
                  description: "Array of 2-4 hex colors for the gradient"
                },
                direction: { 
                  type: "string", 
                  description: "For linear: angle like '135deg' or '90deg'. For radial: position like '50% 50%' or 'center'."
                }
              },
              required: ["type", "colors"]
            },
            theme: {
              type: "string",
              enum: ["light", "dark", "auto"],
              description: "Text theme (not background). 'light' = use light text for dark backgrounds, 'dark' = use dark text for light backgrounds, 'auto' = auto-detect from background brightness."
            }
          },
          required: ["title", "content"],
          additionalProperties: false,
        },
      },
      interactivePrompt: {
        type: "object",
        description: "A DETAILED SIMULATION BLUEPRINT for a 3D visualization that is CENTRAL to teaching this section. Think like a technical artist designing a scientific visualization for a museum exhibit.",
        properties: {
          overview: { type: "string", description: "1-2 sentence summary of the simulation concept and what it teaches" },
          visualLayers: {
            type: "array",
            items: { type: "string" },
            description: "List 4-6 distinct visual layers/systems composing the scene. E.g.: 'Procedural spacetime grid mesh with dynamic vertex displacement based on mass', 'Particle field (200+ points) representing background stars with color coding by universe region', 'Photon probe sphere with geodesic trajectory trail', 'Dashboard panel showing impact parameter and conservation quantities'"
          },
          physicsModel: { type: "string", description: "The specific equations, conservation laws, or mathematical model to simulate. Be precise: name the equations, integration method, and what quantities are conserved. E.g.: 'Geodesic equation on catenoid embedding: conserve angular momentum L=b, compute v_tangential=L/r, detect turning points where v_phi > c, integrate position along surface tangent using ds/dt = v_surf / cosh(y/r0)'" },
          parameterDrama: {
            type: "array",
            items: { type: "string" },
            description: "For each parameter, describe the DRAMATIC visual effect it creates. E.g.: 'throatRadius: Reshapes the entire catenoid surface geometry in real-time, photon orbit changes from pass-through to bounce-back', 'impactParam: Controls angular momentum, visually shifts photon spiral from tight orbit to wide flyby'"
          },
          visualTechniques: {
            type: "array",
            items: { type: "string", enum: ["proceduralGeometry", "particleSystem", "trajectoryTrail", "dynamicVertexUpdate", "colorMappedPhysics", "dashboardGauge", "wireframeOverlay", "emissivePulsing", "multiBodySystem"] },
            description: "Which advanced visual techniques to use (pick at least 3 from the enum list)"
          }
        },
        required: ["overview", "visualLayers", "physicsModel", "parameterDrama", "visualTechniques"]
      }
    },
    required: ["slides", "interactivePrompt"],
    additionalProperties: false,
  };

  const levelInstructions = getLevelInstructions(level);

  const systemPrompt = `
You are an expert educational content creator designing for an INTERACTIVE 3D LEARNING PLATFORM.
You will create slides AND define a 3D simulation that work TOGETHER as a unified learning experience.

${levelInstructions}

FULL COURSE SYLLABUS (Know your scope - what to cover and what NOT to cover):
${syllabusContext || 'Not provided'}

PREVIOUS SECTIONS CONTENT (What the student has already learned):
${previousContext}

CRITICAL SCOPE INSTRUCTIONS:
- You are generating content ONLY for the [CURRENT] section marked above.
- Look at the [UPCOMING] sections - DO NOT cover those topics! They will be taught later.
- Look at the [COMPLETED] sections - DO NOT repeat those topics! They were already taught.
- Stay STRICTLY within the scope of YOUR section's title and description.
- If this is an introductory section, introduce concepts at a high level - save details for later sections.
- If this is an advanced section, assume basics are known and go deeper.

=== SIMULATION-FIRST DESIGN APPROACH ===
IMPORTANT: Think about the 3D simulation FIRST, then design slides that complement it.

1. First, identify: What is the CORE visual concept that can be demonstrated in 3D?
2. Then, design slides that:
   - EXPLAIN what the student will see in the simulation
   - INTRODUCE the variables/parameters they will control
   - CONNECT the visual elements to the underlying theory
   - PREPARE the student to interact meaningfully with the simulation

The simulation should NOT be an afterthought - it's a PRIMARY teaching tool.
Slides should reference the simulation: "In the simulation, you'll see...", "Try adjusting the X parameter to observe...", "Notice how the Y changes when..."

AVOID designing simulations that feel forced or disconnected:
- BAD: Section about "History of Physics" with a random bouncing ball simulation
- GOOD: Section about "Projectile Motion" where the simulation IS the lesson
- BAD: Generic visualization that doesn't teach the specific concept
- GOOD: Targeted simulation where each control demonstrates a key principle

=== CONTENT INSTRUCTIONS ===
- Build upon concepts from previous sections - reference them when introducing new material.
- Introduce ONLY concepts relevant to THIS section's scope.
- Return RAW HTML string for the 'content' field.
- Use Tailwind CSS classes for styling.
- The slide background can be customized via optional fields, but prioritize clear, consistent readability within a section.
- Write like real slides (NOT a textbook):
  * One idea per slide.
  * Prefer bullets over paragraphs.
  * Avoid long prose. No walls of text.
  * Use visual structure every slide (at least one of: a callout box, 2-column layout, checklist, or mini “diagram” using bordered divs).
- HARD BREVITY BUDGET (IMPORTANT):
  * Target ≤ 90 words per slide (excluding LaTeX).
  * Max 5 bullets per slide, max ~10 words per bullet.
  * If you need more text, split into another slide instead of adding paragraphs.
- Use large, readable font sizes: use Tailwind classes such as text-lg or text-xl for body text, and text-2xl or larger for subheadings; avoid text-sm for main body.
- Spread content down the slide using padding and spacing (e.g. py-4, space-y-4) so the slide feels full rather than clustered at the top.
- Use varied layouts:
  * "Title + Bullets"
  * "Split columns (grid-cols-2)"
  * "Highlighted Definition Box"
- Make it visually rich. Use borders and padding. Prefer solid background colors for boxes (e.g. bg-indigo-900/30); avoid CSS gradients so slides stay export-friendly.
- Do NOT include <html> or <body> tags, just the inner content div.
- In at least one slide, explicitly reference the simulation and what students should explore.

HTML STRUCTURE (export-friendly and accessible):
- Put ALL text inside <p>, <h1>-<h6>, <ul>, or <ol>. Never put raw text directly in <div> or <span> (e.g. use <div><p>Text here</p></div>, not <div>Text here</div>).
- For lists, always use <ul> or <ol> with <li> items. Never use manual bullet symbols (•, -, *) in text.
- For highlighted/definition boxes: use a <div> with background/border classes and put the text inside in <p> tags (e.g. <div class="p-4 rounded-lg border ..."><p class="font-bold">Why Trees?</p><p>Explanation.</p></div>).
- Use <b> or <strong> for bold, <i> or <em> for italic, <span> with style for inline color. This keeps structure clean for both web and possible PowerPoint export.
- CRITICAL: NEVER use <img> tags. There is no image hosting system. Use text descriptions, ASCII art, or styled divs to represent visual concepts instead.

CRITICAL - LATEX MATH FORMATTING:
- For inline math, use single dollar signs: $E = mc^2$
- For block/display math, use double dollar signs: $$F = ma$$
- IMPORTANT: Since this is JSON, you MUST double-escape backslashes!
  * In JSON, a single backslash \\ becomes just one backslash in the output
  * So to get \\pi in LaTeX, write \\\\pi in your JSON string
  * To get \\frac{a}{b}, write \\\\frac{a}{b} in JSON

CORRECT EXAMPLES (what you should write in JSON):
  * "The energy is $E = mc^2$ where $m$ is mass." (no backslashes needed)
  * "Period: $$T = 2\\\\pi \\\\sqrt{\\\\frac{L}{g}}$$" (note the double backslashes!)
  * "Force: $$F = ma$$ where $a$ is acceleration."
  * "The angle $\\\\theta$ varies from $0$ to $2\\\\pi$."

WRONG (will break):
  * "$$T = 2\\pi \\sqrt{\\frac{L}{g}}$$" <- Single backslashes will be lost!

Common LaTeX (remember to DOUBLE the backslashes in JSON):
  * Fractions: \\\\frac{a}{b}
  * Square root: \\\\sqrt{x}
  * Greek letters: \\\\pi, \\\\alpha, \\\\beta, \\\\theta, \\\\omega, \\\\lambda
  * Subscripts: x_{1}, v_{0}
  * Superscripts: x^{2}, e^{x}
  * Sum: \\\\sum_{i=1}^{n}
  * Integral: \\\\int_{a}^{b}

CRITICAL - NEVER USE UNICODE SUBSCRIPTS/SUPERSCRIPTS:
  * NEVER use Unicode characters like: ₀₁₂₃₄₅₆₇₈₉₊₋ (subscripts) or ⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻ⁿ (superscripts)
  * These characters BREAK rendering — they appear as broken boxes (☒) because our fonts do not include them.
  * WRONG: "e⁻", "H₂O", "CO₃²⁻", "x²" — these WILL render as broken text!
  * CORRECT: Use LaTeX instead: "$e^{-}$", "$H_2O$", "$CO_3^{2-}$", "$x^2$"
  * ALL math notation MUST use LaTeX $...$ delimiters. Never use bare Unicode math symbols.
`;

  const messages = [
    {
      role: "system",
      content: systemPrompt
    },
    {
      role: "user",
      content: `Generate educational content for SECTION ${sectionNumber}: "${sectionTitle}" of the course "${topic}".

DESIGN APPROACH - Think simulation-first:
1. FIRST: What 3D simulation would BEST teach this concept? What should students see and interact with?
2. THEN: Create 3-4 HTML slides that work WITH the simulation:
   - Introduce the concept and the visual elements students will see
   - Explain the parameters/variables they can control
   - Connect the math/theory to what they'll observe in 3D
   - Include a slide that guides them on what to explore in the simulation

The interactivePrompt must be a DETAILED SIMULATION BLUEPRINT — not a vague wish.
Think like a technical artist designing a scientific visualization for a museum exhibit.

REQUIRED in your blueprint:
- overview: A concise 1-2 sentence summary of the simulation.
- visualLayers: Describe 4-6 DISTINCT visual systems that compose the scene.
  Think in layers: (1) primary phenomenon geometry, (2) environment/context elements,
  (3) interactive probes/test objects, (4) information displays, (5) trails/history.
  Each layer should be specific enough that a developer could implement it independently.
  Example layers: "Procedural grid mesh (40x40 vertices) with dynamic Y-displacement based on gravitational potential, vertex colors lerped from blue (flat) to orange (deep curvature)",
  "Star field particle system (200+ points) with vertexColors coding region identity",
  "Photon probe with geodesic trajectory trail (150-point history buffer)",
  "Dashboard panel at scene edge showing conservation quantities and gauge meter".
- physicsModel: Name the SPECIFIC equations, conservation laws, and integration method.
  Don't say "simulate gravity" — say "Newtonian gravity F=-GMm/r^2 with symplectic Euler integration,
  conserving angular momentum L=mvr, with softening parameter epsilon=0.1 to prevent singularity."
  Don't say "show wave behavior" — say "Standing wave y=A*sin(kx)*cos(wt) with k=2pi/lambda,
  superposition of incident and reflected waves, nodes and antinodes highlighted by color mapping amplitude to emissive intensity."
- parameterDrama: For EACH parameter, describe the DRAMATIC visual effect it creates.
  Don't say "slider for mass" — say "mass slider dynamically deforms the spacetime grid
  mesh vertices in real-time, shifts color gradient from blue (flat) to orange (deep curvature),
  and changes probe orbit from flyby to capture."
- visualTechniques: Pick at least 3 advanced techniques from: proceduralGeometry, particleSystem,
  trajectoryTrail, dynamicVertexUpdate, colorMappedPhysics, dashboardGauge, wireframeOverlay,
  emissivePulsing, multiBodySystem.

Remember: The student has already completed ${sectionNumber - 1} previous section(s). Build on that knowledge.`
    }
  ];

  // Use fast tier for slide generation (Gemini 2.5 Flash)
  const result = await callLLM(messages, schema, "section_content_schema", "fast");

  // Enforce “slide-like” density even when model outputs verbose content.
  return {
    ...result,
    slides: (result.slides || []).map((s: Slide) => ({
      ...s,
      content: compressSlideHtml(s.content, s.title),
    })),
  };
};

// 3. Generate Interactive 3D Code
export const generateInteractiveCode = async (
  topic: string,
  sectionTitle: string,
  simulationDescription: string,
  previousContext: string,
  currentSlidesContext: string,
  sectionNumber: number,
  level: LearningLevel = 'highschool'  // Learning level
): Promise<InteractiveConfig> => {
  const schema = {
    type: "object",
    properties: {
      params: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Variable name used in code (camelCase)" },
            label: { type: "string", description: "Human readable label" },
            controlType: { type: "string", enum: ['slider', 'toggle', 'button'] },
            min: { type: "number", description: "Minimum value for slider (use 0 for toggle/button)" },
            max: { type: "number", description: "Maximum value for slider (use 1 for toggle/button)" },
            step: { type: "number", description: "Step size for slider (use 1 for toggle/button)" },
            defaultValue: { type: "number", description: "For toggle: 1=true, 0=false. For button: 0." },
          },
          required: ["name", "label", "controlType", "min", "max", "step", "defaultValue"],
          additionalProperties: false,
        },
      },
      code: {
        type: "string",
        description: "The function body of a React Functional Component using @react-three/fiber. Do NOT include imports. Do NOT return the component, just the body."
      }
    },
    required: ["params", "code"],
    additionalProperties: false,
  };

  const levelInstructions = getLevelInstructions(level);

  const systemPrompt = `
You are an expert React Three Fiber developer.
Your task is to write the *body* of a React Functional Component that visualizes a concept.

=== FATAL ERROR WARNING — READ THIS FIRST ===
The #1 cause of simulation crashes is passing THREE.js constructor instances as React children.
This causes the runtime error:
  "Objects are not valid as a React child (found: object with keys {isBufferGeometry, uuid, name, type, ...})"

NEVER use "new THREE.<Geometry>(...)" or "new THREE.<Material>(...)" as CHILDREN of React.createElement.
This causes the runtime error shown above.

WRONG (CAUSES CRASH — geometry as child):
  React.createElement('mesh', null, new THREE.BoxGeometry(1,1,1), new THREE.MeshStandardMaterial({color:'red'}))

CORRECT (declarative R3F elements as children):
  React.createElement('mesh', null,
    React.createElement('boxGeometry', { args: [1,1,1] }),
    React.createElement('meshStandardMaterial', { color: 'red' })
  )

=== TWO PATTERNS FOR GEOMETRY — KNOW WHEN TO USE EACH ===

**PATTERN A — Declarative (for simple static meshes):**
Geometry as a React.createElement CHILD inside a mesh. This is the default for most objects.
  React.createElement('mesh', null,
    React.createElement('sphereGeometry', { args: [1, 32, 32] }),
    React.createElement('meshStandardMaterial', { color: '#4a9eff', emissive: '#1a3a77' })
  )

**PATTERN B — Imperative (for DYNAMIC/PROCEDURAL geometry that needs method calls):**
When you need to call .rotateX(), .translate(), .setAttribute(), update vertices in useFrame, etc.,
create an actual THREE geometry instance with \`new THREE.XxxGeometry(...)\` inside React.useMemo,
then pass it as a \`geometry\` prop to 'mesh', 'lineSegments', or 'points'.
  const gridGeo = React.useMemo(() => {
    const geo = new THREE.PlaneGeometry(20, 20, 40, 40);
    geo.rotateX(-Math.PI / 2);  // This works because geo IS a real Three.js geometry
    return geo;
  }, []);
  // Then: React.createElement('mesh', { geometry: gridGeo }, React.createElement('meshStandardMaterial', { ... }))

CRITICAL: React.createElement('planeGeometry', ...) returns a React ELEMENT, NOT a geometry.
You CANNOT call .rotateX(), .setAttribute(), etc. on a React element — it will crash!
  WRONG: const geo = React.createElement('planeGeometry', { args: [...] }); geo.rotateX(...) // CRASH!
  CORRECT: const geo = new THREE.PlaneGeometry(...); geo.rotateX(...) // Works!

Before finalizing your code, SELF-CHECK for "new THREE.":
  Allowed constructor usages:
  - new THREE.BufferGeometry()      (for line/points and custom geometry)
  - new THREE.PlaneGeometry(...)    (when you need .rotateX/.setAttribute/vertex updates)
  - new THREE.SphereGeometry(...)   (when you need to modify the geometry instance)
  - new THREE.LatheGeometry(...)    (for surfaces of revolution)
  - Any geometry with "new THREE." is OK IF stored in a useMemo variable for procedural use
  - new THREE.Float32BufferAttribute(...)
  - new THREE.BufferAttribute(...)
  - new THREE.Vector3(...), new THREE.Vector2(...)
  - new THREE.Color(...)
  - new THREE.MathUtils...
  NEVER allowed: new THREE.XxxMaterial(...) — always use React.createElement for materials.
=== END FATAL ERROR WARNING ===

${levelInstructions}

SIMULATION COMPLEXITY BASED ON LEVEL:
- Beginner: Simple, colorful, playful. Few controls (2-3). Focus on "what happens when I do X?"
- High School: Demonstrate key formulas visually. Medium controls (3-4). Show cause and effect.
- Undergraduate: More sophisticated visualizations. More controls (4-5). Show mathematical relationships.
- Graduate: Complex phenomena, phase spaces, multiple coupled variables. Advanced controls (5+).

=== VISUAL DESIGN PRINCIPLES — MAKE IT LOOK STUNNING ===
Your simulation must look POLISHED and BEAUTIFUL, like a professional scientific visualization — NOT a bare-bones tech demo.
The canvas already provides a subtle ground grid, three-point lighting, and a city environment map for reflections.
Follow these specific techniques to create eye-catching results:

**1. MATERIALS — Add Depth and Richness (CRITICAL)**
NEVER use plain single-color materials like { color: 'red' }. Always add 2-3 material properties:
- Glowing/active objects: { color: '#4a9eff', emissive: '#1a4a99', emissiveIntensity: 0.5, roughness: 0.6 }
- Metallic surfaces: { color: '#c0c8d8', metalness: 0.8, roughness: 0.15 }
- Translucent containers: { color: '#88ccff', transparent: true, opacity: 0.25, side: THREE.DoubleSide, roughness: 0.3 }
- Hot/energetic objects: { color: '#ff6b35', emissive: '#cc3300', emissiveIntensity: 0.6 }
- Important indicators: Add emissive glow to draw the eye to focal points
- Use meshStandardMaterial for most objects (supports metalness, roughness, emissive for PBR rendering)
- DARK BACKGROUND RULE: The canvas background is DARK/BLACK. Every object MUST have emissive glow to be visible. Objects without emissive will appear as dark silhouettes. For neutral/secondary objects, use at least emissiveIntensity: 0.2-0.3 with a matching color.

**2. COLOR PALETTES — Bright & Visible on DARK Background (CRITICAL)**
The scene has a DARK/BLACK background. ALL colors must be clearly visible against it.
AVOID pure #ff0000, #00ff00, #0000ff — they look cheap and harsh.
AVOID dull/muted grays like '#94a3b8', '#6b7280', '#9ca3af' for ANY visible element — they are nearly INVISIBLE on the dark background!
AVOID very low opacity values (< 0.3) on lines or transparent elements — they vanish against dark backgrounds.

Use these curated palettes instead (all bright enough for dark backgrounds):
- Science/Physics: '#4a9eff' (electric blue), '#ff6b35' (warm orange), '#7c5cfc' (violet), '#00d4aa' (teal)
- Biology/Chemistry: '#ff4d6a' (coral), '#36d399' (emerald), '#fbbf24' (amber), '#818cf8' (indigo)
- Math/Abstract: '#f472b6' (pink), '#60a5fa' (sky blue), '#34d399' (mint), '#fbbf24' (gold)
- Neutrals (when you need gray-ish): '#c4b5fd' (light violet), '#93c5fd' (light blue), '#d1d5db' (very light gray) — NEVER darker than '#a0a0a0'
- Use BRIGHTER shades with emissive glow for focal points; use slightly dimmer (but still visible) versions for secondary elements
- For LINES (orbits, paths, field lines): use opacity >= 0.35 minimum, prefer 0.4-0.6. Lines with opacity < 0.3 are INVISIBLE.
- For transparent containers/shells: use opacity >= 0.2 with emissive glow to ensure visibility
- Dynamically shift emissive color/intensity when parameter values change to draw attention

**3. ANIMATION — Smooth and Organic, NEVER Jerky**
- LERP for smooth transitions: currentVal += (targetVal - currentVal) * 0.05 (each frame via useFrame)
- DAMPING for natural deceleration: velocity *= 0.98
- GENTLE AMBIENT MOTION on static objects: y += Math.sin(clock.elapsedTime * 1.5) * 0.05
- PULSING GLOW for active elements: ALWAYS check material exists first with && operator
  * CORRECT: if (ref.current && ref.current.material) { ref.current.material.emissiveIntensity = ... }
  * WRONG: ref.current.material.emissiveIntensity = ... (can crash if material not ready)
- NEVER snap values instantly — always animate transitions over multiple frames
- Add subtle floating/bobbing to important objects even when "idle"

**4. SCENE COMPOSITION — Create Visual Depth**
- Position your main scene above y=0 (the ground grid is at y=0)
- Create VISUAL HIERARCHY: main subject larger + brighter, secondary elements smaller + dimmer
- Use VARYING HEIGHTS: spread objects vertically, don't clump everything at y=0
- Add CONNECTING ELEMENTS: thin lines or arcs between related objects to show relationships
- Main objects should be 0.5-2.5 units in size, centered near origin

**4b. MULTI-LAYERED SCENE COMPOSITION — The Key to Beautiful Simulations**
Think of your simulation as 5 composited layers, like a film VFX pipeline:

LAYER 1 — PRIMARY PHENOMENON: The main physics object/geometry. Use procedural geometry
  with dynamic vertex updates in useFrame for living, breathing surfaces. Update
  vertex positions AND colors every frame based on physics parameters.
  Examples: spacetime grid with gravity wells, wave surface, electromagnetic field mesh.

LAYER 2 — ENVIRONMENT: Background context that gives spatial grounding. Star fields
  (200+ points with vertexColors), reference grids, orbit path indicators, axis lines.
  These should subtly animate (slow rotation, gentle pulsing).

LAYER 3 — INTERACTIVE PROBES: Test particles, photons, or objects the user launches
  into the scene. These follow the physics of Layer 1 (geodesics on surfaces, forces
  from fields). Always include trajectory trails (history array + setFromPoints).

LAYER 4 — INFORMATION DISPLAYS: Dashboard panels, gauge meters, dynamic value readouts.
  Build these as 3D UI elements (boxes + Text children) positioned at scene edges.
  Tie needle rotations and colors to physics quantities.

LAYER 5 — VISUAL EFFECTS: Glow rings (torus at key boundaries), connecting lines
  (bezier curves between related objects), pulsing emissive highlights on focal points.

AIM FOR AT LEAST 4 OF THESE 5 LAYERS in every simulation. A simulation with only
Layer 1 looks like a tech demo. With all 5, it looks like a museum exhibit.

**5. INTERACTIVITY — Make Parameters Feel Impactful**
- Each parameter must cause VISIBLE, IMMEDIATE change via smooth animation (not instant snaps)
- Use COLOR INTERPOLATION for value ranges: lerp from blue (#4a9eff) to red (#ff6b35) based on intensity
- SCALE objects based on parameters (bigger mass = bigger sphere, smoothly animated)
- Tie ANIMATION SPEED to relevant parameters (higher energy = faster motion)
- Add GLOW INTENSITY that increases with parameter magnitude: emissiveIntensity = 0.2 + paramValue * 0.5

PREVIOUS SECTIONS (What student already learned):
${previousContext}

CURRENT SECTION SLIDES (What this simulation should help visualize):
${currentSlidesContext}

CRITICAL RULES:
1. **NO IMPORTS OR DECLARATIONS**: The following are ALREADY AVAILABLE in scope - DO NOT import, declare, or destructure them:
   - React (use React.useRef, React.useEffect, React.useState, React.useMemo, React.createElement, etc.)
   - THREE (use THREE.MathUtils, THREE.Vector3, THREE.Color, THREE.BufferGeometry, THREE.Float32BufferAttribute, etc.)
   - useFrame (already available, just use it directly)
   - useThree (already available, just use it directly)
   - Text (from @react-three/drei - for adding 3D text labels)
   - params (already available as a prop)
2. **React Elements ONLY**: You MUST return a React Element tree using \`React.createElement\`.
   NEVER call new THREE.BoxGeometry(), new THREE.SphereGeometry(), new THREE.MeshStandardMaterial(), etc.
   NEVER pass geometry or material as a prop: \`{ geometry: ..., material: ... }\`
   - CRASH: \`React.createElement('mesh', null, new THREE.BoxGeometry())\` <- geometry instance as child = CRASH.
   - CRASH: \`React.createElement('mesh', { geometry: new THREE.SphereGeometry(1,32,32) })\` <- geometry prop = CRASH.
   - CRASH: \`return new THREE.Mesh(...)\` <- imperative THREE object = CRASH.
   - CORRECT: \`React.createElement('mesh', null, React.createElement('boxGeometry', { args: [1,1,1] }), React.createElement('meshStandardMaterial', { color: 'red' }))\`
3. **No JSX**: The environment does not support JSX.
4. **ALLOWED GEOMETRIES**: You can use these standard geometries:
   - boxGeometry, sphereGeometry, cylinderGeometry, coneGeometry, planeGeometry, torusGeometry, circleGeometry
   - tubeGeometry (for pipes, vessels, curved paths)
   - ringGeometry (for orbits, circular indicators)
   - torusKnotGeometry (for interesting mathematical shapes)
   - latheGeometry (ENCOURAGED for surfaces of revolution — funnels, wormholes, vases, bells, trumpet shapes. Create a profile curve with THREE.Vector2 points and pass to latheGeometry)
   - DO NOT use: textGeometry, shapeGeometry, extrudeGeometry
   - DO NOT load external assets (GLTF, textures, fonts, images)

5. **LINES AND VECTORS** - For drawing lines, arrows, trajectories, and force vectors:
   Use the 'line' element with a THREE.BufferGeometry created via React.useMemo:
   \`\`\`
   const lineGeometry = React.useMemo(() => {
     const geo = new THREE.BufferGeometry();
     const points = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(2, 1, 0), new THREE.Vector3(4, 0, 0)];
     geo.setFromPoints(points);
     return geo;
   }, []);
   // Then use: React.createElement('line', { geometry: lineGeometry }, React.createElement('lineBasicMaterial', { color: '#00ff00' }))
   \`\`\`
   
   For ARROWS (force vectors, velocity vectors):
   - Draw the shaft as a line
   - Draw the arrowhead as a small cone at the end
   - Example arrow from origin pointing in +X direction:
   \`\`\`
   React.createElement('group', null,
     React.createElement('line', { geometry: shaftGeometry }, React.createElement('lineBasicMaterial', { color: 'yellow', linewidth: 2 })),
     React.createElement('mesh', { position: [2, 0, 0], rotation: [0, 0, -Math.PI/2] },
       React.createElement('coneGeometry', { args: [0.1, 0.3, 8] }),
       React.createElement('meshStandardMaterial', { color: 'yellow' })
     )
   )
   \`\`\`

6. **PARTICLE SYSTEMS** - For visualizing flows, fields, or collections of points:
   Use 'points' element with a BufferGeometry containing position attributes:
   \`\`\`
   const particleGeometry = React.useMemo(() => {
     const geo = new THREE.BufferGeometry();
     const positions = new Float32Array(particleCount * 3);
     for (let i = 0; i < particleCount; i++) {
       positions[i * 3] = (Math.random() - 0.5) * 10;     // x
       positions[i * 3 + 1] = (Math.random() - 0.5) * 10; // y
       positions[i * 3 + 2] = (Math.random() - 0.5) * 10; // z
     }
     geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
     return geo;
   }, []);
   // Then use: React.createElement('points', { geometry: particleGeometry }, React.createElement('pointsMaterial', { color: '#ff0000', size: 0.1 }))
   \`\`\`
   
   To ANIMATE particles, store the geometry in a ref and update in useFrame:
   \`\`\`
   const particlesRef = React.useRef();
   useFrame((state, delta) => {
     if (particlesRef.current) {
       const positions = particlesRef.current.geometry.attributes.position.array;
       for (let i = 0; i < positions.length; i += 3) {
         positions[i + 1] += delta * speed; // Move Y up
         if (positions[i + 1] > 5) positions[i + 1] = -5; // Loop back
       }
       particlesRef.current.geometry.attributes.position.needsUpdate = true;
     }
   });
   \`\`\`

7. **TRAJECTORY TRAILS** - To show the path of a moving object:
   Store position history in a ref and update a line geometry:
   \`\`\`
   const trailRef = React.useRef();   // ref on the <line> element, NOT on <bufferGeometry>
   const historyRef = React.useRef([]);
   useFrame(() => {
     if (objectRef.current && trailRef.current) {
       const pos = objectRef.current.position.clone();
       historyRef.current.push(pos);
       if (historyRef.current.length > 100) historyRef.current.shift();
       // IMPORTANT: call .geometry.setFromPoints(), NOT .setFromPoints() directly!
       // trailRef.current is a THREE.Line — the BufferGeometry is at .geometry
       trailRef.current.geometry.setFromPoints(historyRef.current);
     }
   });
   \`\`\`
   
   **COMMON FATAL MISTAKE with setFromPoints:**
   - CRASH: \`lineRef.current.setFromPoints(points)\` ← lineRef points to THREE.Line, which has NO setFromPoints!
   - CORRECT: \`lineRef.current.geometry.setFromPoints(points)\` ← .geometry IS the BufferGeometry
   - ALSO CORRECT: Create geometry in useMemo and pass as prop to <line>:
     \`\`\`
     const geo = React.useMemo(() => { const g = new THREE.BufferGeometry(); g.setFromPoints(points); return g; }, [dep]);
     React.createElement('line', { geometry: geo }, React.createElement('lineBasicMaterial', { color: '#fff' }))
     \`\`\`
   - If you store a ref to a <bufferGeometry> child, then ref.current.setFromPoints() IS valid. But prefer the .geometry pattern above.

7b. **MULTIPLE MOVING OBJECTS** - Animating many particles/probes/rockets simultaneously:
   **WRONG PATTERN (causes laggy/glitchy animation):**
   \`\`\`
   const rocketsRef = React.useRef([]);  // array of { pos: Vector3, vel: Vector3 }
   useFrame(() => {
     rocketsRef.current.forEach(rocket => {
       rocket.pos.x += rocket.vel.x * delta;  // Update state
     });
   });
   // ❌ PROBLEM: position is evaluated ONCE when component renders, not every frame!
   return React.createElement('group', null,
     ...rocketsRef.current.map(rocket => 
       React.createElement('mesh', { position: [rocket.pos.x, rocket.pos.y, rocket.pos.z] }, ...) // Never moves!
     )
   );
   \`\`\`
   
   **CORRECT PATTERN — Pre-allocate mesh refs and update them in useFrame:**
   \`\`\`
   // Pre-allocate a pool of mesh refs (e.g., 6 rockets max)
   const rocketMeshRefs = React.useRef([]); // array of refs to mesh objects
   const rocketStates = React.useRef([]);   // array of { pos: Vector3, vel: Vector3, active: bool }
   
   // Initialize mesh refs
   if (rocketMeshRefs.current.length === 0) {
     for (let i = 0; i < 6; i++) {
       rocketMeshRefs.current[i] = { current: null };
     }
   }
   
   React.useEffect(() => {
     if (params.launchButton > lastLaunchRef.current) {
       lastLaunchRef.current = params.launchButton;
       // Find an inactive slot
       let slot = rocketStates.current.findIndex(r => !r.active);
       if (slot === -1) slot = 0; // reuse oldest
       rocketStates.current[slot] = { 
         pos: new THREE.Vector3(5, 0, 0), 
         vel: new THREE.Vector3(-2, 0, 1),
         active: true,
         history: []
       };
     }
   }, [params.launchButton]);
   
   useFrame((state, delta) => {
     rocketStates.current.forEach((rocket, idx) => {
       if (!rocket.active) return;
       
       // Update physics
       rocket.pos.add(rocket.vel.clone().multiplyScalar(delta));
       
       // ✅ Update the MESH position directly via ref (this runs every frame!)
       if (rocketMeshRefs.current[idx]?.current) {
         rocketMeshRefs.current[idx].current.position.copy(rocket.pos);
         rocketMeshRefs.current[idx].current.visible = true;
       }
       
       // Update trail
       rocket.history.push(rocket.pos.clone());
       if (rocket.history.length > 100) rocket.history.shift();
     });
   });
   
   // Render: Fixed pool of meshes, visibility toggled by state
   return React.createElement('group', null,
     ...Array.from({ length: 6 }, (_, i) => 
       React.createElement('mesh', { 
         key: 'rocket-' + i,
         ref: (el) => { rocketMeshRefs.current[i] = { current: el }; },
         visible: false  // useFrame will set visibility based on active state
       },
         React.createElement('sphereGeometry', { args: [0.15, 12, 12] }),
         React.createElement('meshStandardMaterial', { color: '#fbbf24', emissive: '#fbbf24', emissiveIntensity: 1.0 })
       )
     )
   );
   \`\`\`
   
   KEY PRINCIPLE: When animating position/rotation/scale every frame, you MUST update the mesh
   via a ref in useFrame. Never rely on the position prop being re-evaluated — it only evaluates
   when the component re-renders (parameter changes).

8. **TEXT LABELS** - Guidelines for clean, educational UI:
   - Use: \`React.createElement(Text, { position: [x, y, z], fontSize: 0.3, color: "white", anchorX: "center" }, "Label")\`
   - **LABELS CAN BE DESCRIPTIVE**: Up to 6-8 words is OK (e.g., "Oxygen-rich blood", "Left Ventricle", "Force Vector F")
   - **LIMIT TO 6-8 LABELS MAX**: Label important objects and concepts clearly
   - **FOR DYNAMIC VALUES**: Show concise info like "v: 5.2 m/s" or "Mass: 5kg"
   - **POSITION CLEARLY**: Place labels above or beside objects, avoid overlapping
   - **USE READABLE COLORS**: White or light colors. Add outlineWidth: 0.02 for contrast
   - **GOOD**: "Right Atrium", "Oxygenated Blood", "Force F = 10N", "Velocity", "e-", "H2O", "q1"
   - **AVOID**: Very long sentences or complex multi-line formulas
   - **CRITICAL - NO UNICODE SUBSCRIPTS/SUPERSCRIPTS**: The 3D font CANNOT render Unicode subscripts (₀₁₂₃₄₅₆₇₈₉₊₋) or superscripts (⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻). They appear as BROKEN BOX characters (☒).
     * WRONG: "e⁻", "H₂O", "q₁", "x²", "CO₃²⁻" — these WILL show as broken boxes!
     * CORRECT: "e-", "H2O", "q1", "x^2", "CO3 2-" — use plain ASCII only!
     * Also WRONG: LaTeX notation like "$e^{-}$" — the 3D Text component does NOT support LaTeX.
     * Use ONLY plain ASCII characters in ALL Text labels. No special Unicode symbols.

9. **MESH GEOMETRY RULES** - CRITICAL (violating this = CRASH):
   - For SIMPLE meshes: geometry and material MUST be React.createElement CHILDREN:
     CORRECT: \`React.createElement('mesh', null, React.createElement('boxGeometry', { args: [1,1,1] }), React.createElement('meshStandardMaterial', { color: 'red' }))\`
   - NEVER pass geometry/material INLINE as constructor instances as children:
     CRASH: \`React.createElement('mesh', null, new THREE.BoxGeometry(1,1,1))\`
     CRASH: \`React.createElement('mesh', null, new THREE.MeshStandardMaterial({color:'red'}))\`
   - For PROCEDURAL/DYNAMIC meshes (grids, surfaces): you CAN pass a geometry instance as a \`geometry\` PROP, but it MUST be created in React.useMemo:
     CORRECT: \`const geo = React.useMemo(() => { const g = new THREE.PlaneGeometry(20,20,40,40); g.rotateX(-Math.PI/2); return g; }, []);\`
     Then: \`React.createElement('mesh', { geometry: geo }, React.createElement('meshStandardMaterial', { ... }))\`
   - For 'line', 'lineSegments' and 'points' elements, you CAN pass a THREE.BufferGeometry instance as a geometry prop
   - NEVER use new THREE.XxxMaterial(...) — always use React.createElement for materials

Parameters Handling:
- 'params' prop contains current values.
- For 'slider' type: Set appropriate min/max/step values. params.name will be a number in that range.
- For 'toggle' type: Set min=0, max=1, step=1. params.name is 1 (true) or 0 (false). Use 'params.name > 0.5' to check.
- For 'button' type: Set min=0, max=100, step=1. params.name is a counter that increments on click. Use 'React.useEffect' with [params.name] dependency to trigger actions (like reset).

Code Requirements:
- **VISUALIZE THE SLIDES**: Your simulation should directly help explain the concepts from the current section's slides.
- **RICH VISUAL ELEMENTS**: Combine multiple element types for a polished look:
  * MESHES with rich materials (always include emissive + emissiveIntensity for glow, plus metalness/roughness) for solid objects
  * LINES for force vectors, velocity arrows, trajectories, field lines, and connections between objects
  * PARTICLES for flows (blood, fluid, electrons), fields, and distributed phenomena
  * TEXT LABELS (4-8) to identify key parts clearly (e.g., "Left Ventricle", "Force F=10N")
- **ANIMATION IS MANDATORY**: Every simulation MUST have smooth, continuous animation via useFrame.
  * Use LERP (value += (target - value) * 0.05) for all transitions — NEVER snap values instantly
  * Add subtle ambient motion to "static" objects: posY += Math.sin(clock.elapsedTime * 1.5) * 0.05
  * Pulse emissiveIntensity on highlighted objects: 0.3 + Math.sin(clock.elapsedTime * 3) * 0.15
  * NEVER have a completely static scene — something should always be subtly moving
- **MATERIAL QUALITY**: Do NOT use plain { color: 'red' } materials.
  * Always add emissive glow to important objects: { color: '#4a9eff', emissive: '#1a3a77', emissiveIntensity: 0.4 }
  * Add metalness/roughness for realism: { metalness: 0.2, roughness: 0.6 }
  * Use transparency for containers/enclosures: { transparent: true, opacity: 0.25, side: THREE.DoubleSide }
- **CURATED COLORS (dark background!)**: Avoid pure primaries and dull grays — they are invisible on the dark canvas.
  * Blues: '#4a9eff', '#38bdf8', '#818cf8' | Reds/Warm: '#ff6b35', '#f472b6', '#ef4444'
  * Greens: '#34d399', '#00d4aa' | Accents: '#fbbf24', '#f59e0b', '#7c5cfc'
  * Neutrals: '#c4b5fd' (light violet), '#93c5fd' (light blue) — NEVER use dark grays like '#94a3b8' or '#6b7280'
  * Lines/orbits/paths: opacity >= 0.35 minimum (0.15 is INVISIBLE). Prefer 0.4-0.6.
- **RESPONSIVE INTERACTIONS**: Every parameter must cause clear, visible changes with smooth animated transitions.
- **SCENE LAYOUT**: Center at [0,0,0], main objects 0.5-2.5 units, spread vertically (don't clump at y=0). Ground grid is at y=0.

=== PHYSICS SIMULATION QUALITY ===
Your simulation should implement REAL physics, not just "move things around":

**Conservation Laws**: If there's a force, conserve the right quantities:
- Gravity/orbits: Conserve angular momentum L = r * v_tangential
- Collisions: Conserve momentum and (optionally) energy
- Waves: Conserve energy, show proper dispersion
- Electromagnetic: Show field lines following Gauss's law, forces following Coulomb/Biot-Savart

**Numerical Integration**: Use proper methods, not just position += velocity * dt:
- Store velocity AND position separately in refs
- Apply forces to velocity first, then update position (symplectic Euler minimum)
- Add softening parameters to prevent singularities: force = GM / (r^2 + epsilon)
- Cap delta time: const dt = Math.min(delta, 0.05) for stability

**Color-Mapped Physics**: Map physical quantities to visual properties:
- Curvature/stress -> color gradient (blue=low, orange=high via THREE.MathUtils.lerp on vertex colors)
- Velocity -> trail brightness or particle size
- Energy -> emissive intensity
- Temperature -> color temperature (blue=cold, red=hot)
- Potential -> surface height (gravity wells, potential landscapes)

**Turning Points and Boundaries**: Handle edge cases visually:
- Show what happens at boundaries (reflection, absorption, tunneling)
- Detect and visualize forbidden regions (where v^2 < 0)
- Reset/loop probes gracefully instead of letting them fly to infinity
- Add boundary checks: if (r > 15 || r < 0.3) reset or deactivate

=== EXAMPLE 1: Simple Physics with Vectors (note the rich materials) ===
Shows a projectile with velocity vector and trajectory trail:
"
  const ballRef = React.useRef();
  const trailRef = React.useRef();
  const historyRef = React.useRef([]);
  const velocityRef = React.useRef({ x: params.velocity * Math.cos(params.angle * Math.PI / 180), y: params.velocity * Math.sin(params.angle * Math.PI / 180) });
  const posRef = React.useRef({ x: -4, y: 0.5 });

  const trailGeometry = React.useMemo(() => new THREE.BufferGeometry(), []);
  const arrowGeometry = React.useMemo(() => {
    const geo = new THREE.BufferGeometry();
    geo.setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0)]);
    return geo;
  }, []);

  React.useEffect(() => {
    if (params.reset > 0) {
      posRef.current = { x: -4, y: 0.5 };
      velocityRef.current = { x: params.velocity * Math.cos(params.angle * Math.PI / 180), y: params.velocity * Math.sin(params.angle * Math.PI / 180) };
      historyRef.current = [];
      if (ballRef.current) ballRef.current.position.set(-4, 0.5, 0);
    }
  }, [params.reset]);

  // Smooth, continuous animation with ambient motion
  useFrame((state, delta) => {
    if (params.isPlaying > 0.5 && ballRef.current) {
      velocityRef.current.y -= 9.8 * delta;
      posRef.current.x += velocityRef.current.x * delta;
      posRef.current.y += velocityRef.current.y * delta;
      if (posRef.current.y < 0.3) posRef.current.y = 0.3;
      ballRef.current.position.set(posRef.current.x, posRef.current.y, 0);
      
      historyRef.current.push(new THREE.Vector3(posRef.current.x, posRef.current.y, 0));
      if (historyRef.current.length > 200) historyRef.current.shift();
      if (trailRef.current) trailRef.current.geometry.setFromPoints(historyRef.current);
    }
    // Subtle ambient glow pulsing on the ball even when paused
    if (ballRef.current && ballRef.current.material) {
      ballRef.current.material.emissiveIntensity = 0.4 + Math.sin(state.clock.elapsedTime * 3) * 0.15;
    }
  });

  const vx = velocityRef.current.x;
  const vy = velocityRef.current.y;
  const vMag = Math.sqrt(vx * vx + vy * vy);
  const vAngle = Math.atan2(vy, vx);

  return React.createElement('group', null,
    // Projectile ball — rich material with glow
    React.createElement('mesh', { ref: ballRef, position: [-4, 0.5, 0] },
      React.createElement('sphereGeometry', { args: [0.3, 32, 32] }),
      React.createElement('meshStandardMaterial', { color: '#4a9eff', emissive: '#1a4a99', emissiveIntensity: 0.4, metalness: 0.3, roughness: 0.4 })
    ),
    React.createElement(Text, { position: [-4, 1.5, 0], fontSize: 0.3, color: '#fbbf24', anchorX: 'center', outlineWidth: 0.02 }, 'Projectile'),
    
    // Trajectory trail — warm gold color
    React.createElement('line', { ref: trailRef, geometry: trailGeometry },
      React.createElement('lineBasicMaterial', { color: '#fbbf24', linewidth: 2 })
    ),
    
    // Velocity vector arrow
    React.createElement('group', { position: [posRef.current.x, posRef.current.y, 0], rotation: [0, 0, vAngle], scale: [vMag * 0.2, 1, 1] },
      React.createElement('line', { geometry: arrowGeometry },
        React.createElement('lineBasicMaterial', { color: '#34d399' })
      ),
      React.createElement('mesh', { position: [1, 0, 0], rotation: [0, 0, -Math.PI/2] },
        React.createElement('coneGeometry', { args: [0.08, 0.2, 8] }),
        React.createElement('meshStandardMaterial', { color: '#34d399', emissive: '#1a7a55', emissiveIntensity: 0.5 })
      )
    ),
    React.createElement(Text, { position: [posRef.current.x + 1, posRef.current.y + 0.5, 0], fontSize: 0.25, color: '#34d399', anchorX: 'center' }, 'Velocity')
  );
"

=== EXAMPLE 2: Particle System (Blood Flow / Fluid) — note transparent vessel + glowing particles ===
Shows particles flowing through a tube-like structure:
"
  const particleCount = 60;
  const particlesRef = React.useRef();
  const vesselRef = React.useRef();
  
  const particleGeometry = React.useMemo(() => {
    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array(particleCount * 3);
    const colors = new Float32Array(particleCount * 3);
    for (let i = 0; i < particleCount; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 1.8;
      positions[i * 3 + 1] = Math.random() * 6 - 3;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 1.8;
      colors[i * 3] = 0.9 + Math.random() * 0.1;
      colors[i * 3 + 1] = 0.2 + Math.random() * 0.15;
      colors[i * 3 + 2] = 0.2 + Math.random() * 0.1;
    }
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    return geo;
  }, []);

  useFrame((state, delta) => {
    if (params.showFlow > 0.5 && particlesRef.current) {
      const positions = particlesRef.current.geometry.attributes.position.array;
      const speed = params.flowSpeed * delta;
      for (let i = 0; i < particleCount; i++) {
        positions[i * 3 + 1] += speed;
        if (positions[i * 3 + 1] > 3) {
          positions[i * 3 + 1] = -3;
          positions[i * 3] = (Math.random() - 0.5) * 1.5;
          positions[i * 3 + 2] = (Math.random() - 0.5) * 1.5;
        }
      }
      particlesRef.current.geometry.attributes.position.needsUpdate = true;
    }
    // Subtle ambient pulsing on the vessel wall
    if (vesselRef.current && vesselRef.current.material) {
      vesselRef.current.material.opacity = 0.2 + Math.sin(state.clock.elapsedTime * 2) * 0.05;
    }
  });

  return React.createElement('group', null,
    // Vessel/tube — translucent with emissive glow
    React.createElement('mesh', { ref: vesselRef, position: [0, 0.5, 0] },
      React.createElement('cylinderGeometry', { args: [1.2, 1.2, 6, 32, 1, true] }),
      React.createElement('meshStandardMaterial', { color: '#ff4d6a', emissive: '#661133', emissiveIntensity: 0.3, transparent: true, opacity: 0.22, side: THREE.DoubleSide, roughness: 0.3 })
    ),
    React.createElement(Text, { position: [2, 0.5, 0], fontSize: 0.35, color: '#ff4d6a', anchorX: 'left', outlineWidth: 0.02 }, 'Blood Vessel'),
    
    // Blood particles
    React.createElement('points', { ref: particlesRef, geometry: particleGeometry },
      React.createElement('pointsMaterial', { size: 0.15, vertexColors: true, transparent: true, opacity: 0.9 })
    ),
    React.createElement(Text, { position: [0, 4, 0], fontSize: 0.3, color: '#ff6b35', anchorX: 'center' }, 'Oxygenated Blood'),
    
    // Flow direction arrow — glowing accent
    React.createElement('mesh', { position: [0, 4.3, 0] },
      React.createElement('coneGeometry', { args: [0.2, 0.5, 8] }),
      React.createElement('meshStandardMaterial', { color: '#fbbf24', emissive: '#996600', emissiveIntensity: 0.6, metalness: 0.3, roughness: 0.4 })
    ),
    React.createElement(Text, { position: [0, 5, 0], fontSize: 0.25, color: '#fbbf24', anchorX: 'center' }, 'Flow Direction')
  );
"

=== EXAMPLE 3: Force Vectors and Interactions — note emissive glow, ambient animation, curated colors ===
Shows two charged particles with force vectors and smooth ambient motion:
"
  const particle1Ref = React.useRef();
  const particle2Ref = React.useRef();
  
  const forceLineGeo = React.useMemo(() => {
    const geo = new THREE.BufferGeometry();
    geo.setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0)]);
    return geo;
  }, []);

  const separation = params.distance;
  const forceMagnitude = params.charge1 * params.charge2 / (separation * separation);
  const forceScale = Math.min(Math.abs(forceMagnitude) * 0.3, 2);
  const isRepulsive = forceMagnitude > 0;

  // Smooth ambient animation: particles gently float + glow pulses with force strength
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    if (particle1Ref.current) {
      particle1Ref.current.position.y = 0.5 + Math.sin(t * 1.5) * 0.08;
      if (particle1Ref.current.material) {
        particle1Ref.current.material.emissiveIntensity = 0.4 + forceScale * 0.2 + Math.sin(t * 3) * 0.1;
      }
    }
    if (particle2Ref.current) {
      particle2Ref.current.position.y = 0.5 + Math.sin(t * 1.5 + 1) * 0.08;
      if (particle2Ref.current.material) {
        particle2Ref.current.material.emissiveIntensity = 0.4 + forceScale * 0.2 + Math.sin(t * 3 + 1) * 0.1;
      }
    }
  });

  return React.createElement('group', null,
    // Particle 1 (positive — coral with warm glow)
    React.createElement('mesh', { ref: particle1Ref, position: [-separation/2, 0.5, 0] },
      React.createElement('sphereGeometry', { args: [0.4, 32, 32] }),
      React.createElement('meshStandardMaterial', { color: '#ff4d6a', emissive: '#991133', emissiveIntensity: 0.5, metalness: 0.2, roughness: 0.4 })
    ),
    React.createElement(Text, { position: [-separation/2, 1.5, 0], fontSize: 0.3, color: '#ff4d6a', anchorX: 'center', outlineWidth: 0.02 }, 'Charge +q1'),
    
    // Force vector on particle 1
    React.createElement('group', { position: [-separation/2, 0.5, 0], rotation: [0, 0, isRepulsive ? Math.PI : 0], scale: [forceScale, 1, 1] },
      React.createElement('line', { geometry: forceLineGeo },
        React.createElement('lineBasicMaterial', { color: '#fbbf24' })
      ),
      React.createElement('mesh', { position: [1, 0, 0], rotation: [0, 0, -Math.PI/2] },
        React.createElement('coneGeometry', { args: [0.1, 0.25, 8] }),
        React.createElement('meshStandardMaterial', { color: '#fbbf24', emissive: '#996600', emissiveIntensity: 0.5 })
      )
    ),
    
    // Particle 2 (negative — electric blue with cool glow)
    React.createElement('mesh', { ref: particle2Ref, position: [separation/2, 0.5, 0] },
      React.createElement('sphereGeometry', { args: [0.4, 32, 32] }),
      React.createElement('meshStandardMaterial', { color: '#4a9eff', emissive: '#1a3a77', emissiveIntensity: 0.5, metalness: 0.2, roughness: 0.4 })
    ),
    React.createElement(Text, { position: [separation/2, 1.5, 0], fontSize: 0.3, color: '#4a9eff', anchorX: 'center', outlineWidth: 0.02 }, 'Charge -q2'),
    
    // Force vector on particle 2
    React.createElement('group', { position: [separation/2, 0.5, 0], rotation: [0, 0, isRepulsive ? 0 : Math.PI], scale: [forceScale, 1, 1] },
      React.createElement('line', { geometry: forceLineGeo },
        React.createElement('lineBasicMaterial', { color: '#fbbf24' })
      ),
      React.createElement('mesh', { position: [1, 0, 0], rotation: [0, 0, -Math.PI/2] },
        React.createElement('coneGeometry', { args: [0.1, 0.25, 8] }),
        React.createElement('meshStandardMaterial', { color: '#fbbf24', emissive: '#996600', emissiveIntensity: 0.5 })
      )
    ),
    
    // Force label
    React.createElement(Text, { position: [0, -0.8, 0], fontSize: 0.35, color: '#fbbf24', anchorX: 'center', outlineWidth: 0.02 }, 
      isRepulsive ? 'Repulsive Force' : 'Attractive Force'
    ),
    
    // Distance indicator line
    React.createElement('group', { position: [0, -0.2, 0] },
      React.createElement('mesh', { rotation: [0, 0, Math.PI/2] },
        React.createElement('cylinderGeometry', { args: [0.015, 0.015, separation, 8] }),
        React.createElement('meshStandardMaterial', { color: '#6b7280', metalness: 0.5, roughness: 0.5 })
      )
    ),
    React.createElement(Text, { position: [0, -0.5, 0], fontSize: 0.25, color: '#9ca3af', anchorX: 'center' }, 'd = ' + separation.toFixed(1) + ' m')
  );
"

=== EXAMPLE 4: ADVANCED — Multi-Layered Scientific Visualization (THIS IS THE QUALITY TARGET) ===
Shows a gravity well with dynamic mesh, particle systems, probe trajectory, and information display.
THIS is the level of complexity and beauty every simulation should aim for:
"
  // --- REFS for smooth state management (use 5+ refs for rich simulations) ---
  const massRef = React.useRef(0);
  const gridRef = React.useRef();
  const probeRef = React.useRef();
  const trailRef = React.useRef();
  const probeState = React.useRef({ pos: new THREE.Vector3(5, 0, 0), vel: new THREE.Vector3(0, 0, 2), active: false, history: [] });

  // --- LAYER 1: Procedural Geometry with Dynamic Vertex Updates (40x40 grid = 1681 vertices) ---
  const { positions, colors, indices, refPositions } = React.useMemo(() => {
    const size = 14, div = 40, half = size/2, seg = size/div;
    const pos = [], col = [], idx = [], ref = [];
    for (let i = 0; i <= div; i++) {
      for (let j = 0; j <= div; j++) {
        const x = j*seg - half, z = i*seg - half;
        pos.push(x, 0, z);
        col.push(0.29, 0.62, 1.0); // #4a9eff base
        ref.push({ x, z });
      }
    }
    const rowSize = div + 1;
    for (let i = 0; i < div; i++) {
      for (let j = 0; j < div; j++) {
        const a = i * rowSize + j, b = a + 1, c = a + rowSize, d = c + 1;
        idx.push(a, b, a, c);
        if (i === div - 1) idx.push(c, d);
        if (j === div - 1) idx.push(b, d);
      }
    }
    return { positions: new Float32Array(pos), colors: new Float32Array(col), indices: idx, refPositions: ref };
  }, []);

  const gridGeometry = React.useMemo(() => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setIndex(indices);
    return geo;
  }, [positions, indices, colors]);

  // --- LAYER 2: Background Particle Field (200+ points with vertexColors) ---
  const starsGeo = React.useMemo(() => {
    const geo = new THREE.BufferGeometry();
    const count = 200;
    const p = new Float32Array(count * 3), c = new Float32Array(count * 3);
    const colA = new THREE.Color('#4a9eff'), colB = new THREE.Color('#ff6b35');
    for (let i = 0; i < count; i++) {
      const theta = Math.random() * Math.PI * 2, r = 3 + Math.random() * 7;
      const y = (Math.random() - 0.5) * 10;
      p[i*3] = r * Math.cos(theta); p[i*3+1] = y; p[i*3+2] = r * Math.sin(theta);
      const clr = y > 0 ? colA : colB;
      c[i*3] = clr.r; c[i*3+1] = clr.g; c[i*3+2] = clr.b;
    }
    geo.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
    return geo;
  }, []);

  const trailGeo = React.useMemo(() => new THREE.BufferGeometry(), []);

  // --- LAYER 3: Launch probe on button press ---
  React.useEffect(() => {
    if (params.launch > 0) {
      probeState.current.active = true;
      probeState.current.history = [];
      probeState.current.pos.set(-6, 0, 2);
      probeState.current.vel.set(4.0, 0, -1.5);
    }
  }, [params.launch]);

  // --- PHYSICS + ANIMATION in useFrame ---
  useFrame((state, delta) => {
    // Smooth parameter interpolation (NEVER snap values)
    massRef.current += (params.mass - massRef.current) * 0.05;
    const currentMass = massRef.current;

    // LAYER 1: Dynamic vertex displacement + color-mapped physics
    if (gridRef.current) {
      const posAttr = gridRef.current.geometry.attributes.position;
      const colAttr = gridRef.current.geometry.attributes.color;
      for (let i = 0; i < refPositions.length; i++) {
        const { x, z } = refPositions[i];
        const distSq = x*x + z*z;
        const depth = -(currentMass * 3.0) / (1.0 + distSq * 0.3);
        posAttr.setY(i, depth);
        // COLOR-MAPPED PHYSICS: curvature to color gradient (blue=flat, orange=deep)
        const curvature = Math.abs(depth) / (currentMass * 2.5 + 0.1);
        colAttr.setXYZ(i,
          THREE.MathUtils.lerp(0.29, 1.0, curvature),
          THREE.MathUtils.lerp(0.62, 0.42, curvature),
          THREE.MathUtils.lerp(1.0, 0.21, curvature)
        );
      }
      posAttr.needsUpdate = true;
      colAttr.needsUpdate = true;
    }

    // LAYER 3: Probe physics with conservation-law gravity
    if (probeState.current.active && probeRef.current) {
      const p = probeState.current.pos, v = probeState.current.vel;
      const dt = Math.min(delta, 0.05); // Cap for stability
      const rSq = p.x*p.x + p.z*p.z;
      const r = Math.sqrt(rSq);
      // Gravity with softening parameter to prevent singularity
      const forceMag = (currentMass * 15.0) / (rSq * Math.sqrt(rSq) + 0.1);
      v.x -= forceMag * p.x * dt;
      v.z -= forceMag * p.z * dt;
      p.x += v.x * dt;
      p.z += v.z * dt;
      p.y = -(currentMass * 3.0) / (1.0 + (p.x*p.x + p.z*p.z) * 0.3) + 0.2;
      if (r > 15 || r < 0.3) probeState.current.active = false;
      probeRef.current.position.copy(p);
      // Trajectory trail
      probeState.current.history.push(p.clone());
      if (probeState.current.history.length > 150) probeState.current.history.shift();
      if (trailRef.current) trailRef.current.geometry.setFromPoints(probeState.current.history);
    }
  });

  const sphereScale = 0.5 + params.mass * 0.15;
  return React.createElement('group', null,
    // Layer 1: Dynamic spacetime grid
    React.createElement('lineSegments', { ref: gridRef, geometry: gridGeometry },
      React.createElement('lineBasicMaterial', { vertexColors: true, transparent: true, opacity: 0.6 })
    ),
    // Layer 2: Star field environment
    React.createElement('points', { geometry: starsGeo },
      React.createElement('pointsMaterial', { size: 0.12, vertexColors: true, transparent: true, opacity: 0.8, sizeAttenuation: true })
    ),
    // Layer 3: Probe + trajectory trail
    React.createElement('mesh', { ref: probeRef, visible: probeState.current.active },
      React.createElement('sphereGeometry', { args: [0.15, 16, 16] }),
      React.createElement('meshStandardMaterial', { color: '#34d399', emissive: '#00ffaa', emissiveIntensity: 1.0, toneMapped: false })
    ),
    React.createElement('line', { ref: trailRef, geometry: trailGeo },
      React.createElement('lineBasicMaterial', { color: '#34d399', transparent: true, opacity: 0.5 })
    ),
    // Layer 4: Central mass object with rich material
    React.createElement('mesh', { position: [0, -0.5, 0] },
      React.createElement('sphereGeometry', { args: [sphereScale, 32, 32] }),
      React.createElement('meshStandardMaterial', { color: '#fbbf24', emissive: '#e65100', emissiveIntensity: 0.5 + params.mass * 0.1, metalness: 0.8, roughness: 0.2 })
    ),
    // Layer 5: Information labels
    React.createElement(Text, { position: [0, 2 + params.mass * 0.1, 0], fontSize: 0.4, color: '#fbbf24', anchorX: 'center', outlineWidth: 0.02 }, 'Mass Source M'),
    React.createElement(Text, { position: [5, -1, 5], fontSize: 0.3, color: '#4a9eff', rotation: [-Math.PI/2, 0, 0], anchorX: 'center' }, 'Flat Spacetime (R=0)'),
    // Conditional deep-well label
    params.mass > 5 ? React.createElement(Text, { position: [0, -2 - params.mass * 0.3, 0], fontSize: 0.35, color: '#ff6b35', anchorX: 'center', outlineWidth: 0.02 }, 'Deep Gravity Well') : null
  );
"
NOTE: This example shows the TARGET quality level. Every simulation should aim for this
multi-layered composition with 5+ refs, dynamic vertex updates, physics with conservation
laws, particle systems, trajectory trails, and rich materials. Simulations with fewer than
4 layers or under 80 lines of code are too simple.

**BEST PRACTICES**:
- Use LINES for: force vectors, velocity arrows, trajectories, field lines, connections between objects
- Use PARTICLES for: fluid flow, blood, electrons, gas molecules, star fields
- Use MESHES for: solid objects, planets, organs, mechanical parts — ALWAYS with emissive + metalness/roughness
- Use TEXT LABELS for: identifying parts, showing dynamic values, naming forces/concepts
- Use TRANSPARENCY for: containers, vessels, enclosures, overlapping structures — but MINIMUM opacity 0.2 with emissive glow so they're visible on dark background
- Use EMISSIVE GLOW for: focal points, active elements, interactive objects. Pulse glow on highlighted items.
- DARK BACKGROUND VISIBILITY: The canvas is DARK. Every element needs enough brightness/glow to be clearly seen. Lines need opacity >= 0.35. No dull grays. Always add emissive to meshes.
- Use LERP ANIMATION for: ALL transitions. Never snap values. currentVal += (targetVal - currentVal) * 0.05
- Use AMBIENT MOTION for: subtle floating (Math.sin(time)*0.05), gentle rotation, pulsing glow on idle objects
- COMBINE these techniques for rich, polished, professional scientific visualizations!

**VISUAL QUALITY CHECKLIST (verify before finalizing):**
- [ ] Every meshStandardMaterial has emissive + emissiveIntensity set (not just color)
- [ ] No pure primary colors (#ff0000, #00ff00, #0000ff) — use curated palette tones
- [ ] No dull grays (#94a3b8, #6b7280, #9ca3af) — these are INVISIBLE on the dark background
- [ ] ALL lines (orbits, paths, vectors) have opacity >= 0.35 — lower values are invisible
- [ ] ALL Text labels use bright, visible colors — never gray or muted tones
- [ ] useFrame is used for smooth animation — something is always subtly moving
- [ ] Parameter changes cause smooth animated transitions (lerp), not instant snaps
- [ ] Important objects are visually distinct (brighter, glowing, larger) from secondary objects
- [ ] Scene has vertical depth (objects at different Y heights), not all flat on y=0
`;

  const messages = [
    {
      role: "system",
      content: systemPrompt
    },
    {
      role: "user",
      content: `Topic: ${topic}. Section ${sectionNumber}: ${sectionTitle}.
Simulation Request: ${simulationDescription}.

Create a VISUALLY STUNNING, interactive 3D simulation that teaches through beauty and interactivity.
The canvas already provides a ground grid, three-point lighting, and city environment for reflections — build on that.

**CODE COMPLEXITY EXPECTATIONS (simulations that are too simple will be rejected):**
- Your code should be 150-300 lines. Simulations under 80 lines are too simple and lack visual richness.
- Use 6-10 React.useRef hooks for smooth state management of multiple visual systems.
- Compose 4-5 visual layers (primary phenomenon + environment + probes + info displays + effects).
- Implement real physics with conservation laws, not just position += velocity.
- Include at least one dynamic system (particles, trails, or procedural vertex updates).

**VISUAL QUALITY PRIORITIES (your simulation will be judged on these):**
1. **RICH MATERIALS on every mesh**: Always use emissive + emissiveIntensity for glow. Add metalness/roughness. Example:
   React.createElement('meshStandardMaterial', { color: '#4a9eff', emissive: '#1a3a77', emissiveIntensity: 0.4, metalness: 0.2, roughness: 0.6 })
2. **CURATED COLORS**: Use sophisticated tones ('#4a9eff', '#ff6b35', '#34d399', '#7c5cfc', '#fbbf24'), NEVER pure red/blue/green.
3. **SMOOTH ANIMATION**: Everything must animate via useFrame. Use lerp for transitions (val += (target - val) * 0.05). Add subtle ambient motion (floating, pulsing glow) even to idle objects. NEVER snap values instantly.
4. **VISUAL DEPTH**: Use varying heights above y=0, transparency for containers/enclosures, connecting lines between related objects, emissive glow on focal points.
5. **RESPONSIVE CONTROLS**: Each parameter must cause clear, immediate visual feedback with smooth animated transitions. Tie colors, sizes, speeds, and glow intensity to parameters.

**TECHNICAL FEATURES to use where appropriate:**
- **LINES & VECTORS**: Force vectors, velocity arrows, trajectories, field lines
- **PARTICLE SYSTEMS**: Flows (blood, fluid, electrons), fields, distributed phenomena
- **TRAJECTORY TRAILS**: Paths of moving objects with trailing lines
- **ARROWS**: Lines with cone arrowheads for directional quantities

Generate the React Three Fiber code body (using React.createElement) and the control parameters.
Use 'toggle' for play/pause or show/hide states. Use 'button' for reset/trigger actions. Use 'slider' for continuous values.

**CRASH PREVENTION RULES:**
1. MESH elements: geometry+material as CHILDREN via React.createElement, NEVER as props or constructor instances.
   ✓ CORRECT: React.createElement('mesh', null, React.createElement('sphereGeometry', {args:[1,32,32]}), React.createElement('meshStandardMaterial', {color:'#4a9eff'}))
   ✗ WRONG: React.createElement('mesh', {geometry: someGeo}, React.createElement('meshStandardMaterial', {color:'#4a9eff'}))
   
1b. NEVER cache React.createElement geometry elements in useMemo/variables and then use them with 'primitive' or as 'geometry' props:
   ✗ WRONG: \`const geo = React.useMemo(() => React.createElement('sphereGeometry', {args:[1,32,32]}), []); React.createElement('mesh', {geometry: geo}, ...)\`
   ✗ WRONG: \`const geo = React.useMemo(() => React.createElement('torusGeometry', {...}), []); React.createElement('primitive', {object: geo})\`
   ✓ CORRECT (for mesh): Put geometry createElement directly as child, don't cache it
   ✓ CORRECT (for reusable THREE objects): Cache the actual THREE.js instance: \`const geo = React.useMemo(() => new THREE.IcosahedronGeometry(1, 0), []);\` then use as mesh child or with primitive

2. LINE/POINTS/LINELOOP elements: geometry IS passed as a prop, but ONLY when it's a BufferGeometry instance (not a React element).
   ✓ CORRECT: \`const lineGeo = React.useMemo(() => new THREE.BufferGeometry(), []); React.createElement('line', {geometry: lineGeo}, ...)\`
   ✗ WRONG: \`const lineGeo = React.useMemo(() => React.createElement('bufferGeometry'), []); React.createElement('line', {geometry: lineGeo}, ...)\`
3. BufferGeometry always in React.useMemo to prevent recreation every render.
4. Allowed THREE constructors: BufferGeometry, PlaneGeometry (for procedural grids), SphereGeometry (for procedural), LatheGeometry (for surfaces of revolution), Float32BufferAttribute, BufferAttribute, Vector3, Vector2, Color, Euler, Matrix4, MathUtils. ANY geometry constructor is OK when stored in a useMemo for procedural use. NEVER use new THREE.XxxMaterial(...).
5. setFromPoints() ONLY on BufferGeometry: ref.current.geometry.setFromPoints(pts), NOT ref.current.setFromPoints(pts).
6. NEVER call .computeBoundingSphere() — the runtime handles frustum culling automatically. Calling it on the wrong object (e.g. a BufferAttribute instead of BufferGeometry) causes "is not a function" crashes.
6b. CUSTOM CLASSES (e.g., extending THREE.Curve): NEVER define class declarations inside React.useMemo/useEffect callbacks. Classes must be defined at the TOP LEVEL of your code, outside all hooks. 
   WRONG: \`const geo = React.useMemo(() => { class MyCurve extends THREE.Curve {...}; return new THREE.TubeGeometry(new MyCurve(), ...); }, []);\`
   CORRECT: Define class at top: \`class MyCurve extends THREE.Curve {...}\` then use it in useMemo: \`const geo = React.useMemo(() => new THREE.TubeGeometry(new MyCurve(), ...), []);\`
7. HOOKS MUST BE UNCONDITIONAL: NEVER place React.useMemo, React.useEffect, React.useRef, or React.useState inside if/else, for, while, or any conditional block. ALL hook calls must be at the top level of your code. Only the RESULTS of hooks can be used inside conditionals. Example: define \`const geo = React.useMemo(...)\` at the top, then use \`if (condition) { children.push(element_using_geo) }\` below.
8. ALLOWED ELEMENT NAMES ONLY: 'group', 'mesh', 'line', 'lineSegments', 'points', 'instancedMesh', 'ambientLight', 'directionalLight', 'pointLight', 'spotLight', 'hemisphereLight', 'Text', 'PerspectiveCamera', 'OrthographicCamera', 'OrbitControls', 'GridHelper', 'AxesHelper'. Do NOT invent helper elements like 'Translate', 'Rotate', 'Scale', 'Animate', or 'GlowMesh'. To move/rotate/scale things, always wrap them in a 'group' and use position/rotation/scale props on that group.
9. FINAL SELF-CHECK:
   a. Search for "new THREE." — any XxxMaterial constructor = CRASH. Replace with React.createElement. Geometry constructors are OK if stored in useMemo for procedural use.
   b. Verify EVERY React.useRef/useMemo/useEffect/useState is at the outermost indentation level of your code — NOT inside any if/for/while block.
   c. If you have MULTIPLE moving objects (rockets, particles from a launch button, etc): Did you pre-allocate mesh refs and update mesh.position in useFrame? Or did you wrongly use \`position: [stateRef.current.x, y, z]\` in the return statement? The latter only evaluates once and causes laggy animation. See section 7b above for the correct pattern.
   d. NO DUPLICATE VARIABLE DECLARATIONS: Search for duplicate \`const\` declarations of the same variable name (e.g., two \`const meshRef\` at top level). If you define helper functions/components that need their own refs, declare those refs INSIDE the function, not at the top level. Each variable name can only be declared once in the same scope.`
    }
  ];

  const result = await callLLM(messages, schema, "interactive_code_schema", "capable");
  
  // Sanitize the generated code to fix common AI mistakes (e.g. raw THREE constructors)
  const cleanCode = sanitizeSimulationCode(result.code);

  return {
    prompt: simulationDescription,
    code: cleanCode,
    params: result.params
  };
};

// 3d. Edit Simulation Code via search-and-replace (uses Flash, saves tokens)

// Shared schema for patch-based simulation responses (edit + error fix)
const PARAMS_ITEM_SCHEMA = {
  type: "object" as const,
  properties: {
    name: { type: "string" },
    label: { type: "string" },
    controlType: { type: "string", enum: ['slider', 'toggle', 'button'] },
    min: { type: "number" },
    max: { type: "number" },
    step: { type: "number" },
    defaultValue: { type: "number" }
  },
  required: ["name", "label", "controlType", "min", "max", "step", "defaultValue"],
  additionalProperties: false
};

const SIMULATION_PATCH_RESPONSE_SCHEMA = {
  type: "object" as const,
  properties: {
    explanation: { type: "string", description: "Brief explanation of changes made" },
    edits: {
      type: "array" as const,
      description: "Array of search-and-replace operations. old_code must appear EXACTLY in the current code.",
      items: {
        type: "object" as const,
        properties: {
          old_code: { type: "string", description: "Exact substring to find and replace" },
          new_code: { type: "string", description: "Replacement string" }
        },
        required: ["old_code", "new_code"],
        additionalProperties: false
      }
    },
    params: {
      type: "array" as const,
      description: "Full updated params array. Unchanged if no control changes.",
      items: PARAMS_ITEM_SCHEMA
    }
  },
  required: ["explanation", "edits", "params"],
  additionalProperties: false
};

function truncForEdit(s: string, maxLen = 80): string {
  return s.length > maxLen ? s.slice(0, maxLen) + '...' : s;
}

function buildFailedEditsRetryPrompt(
  currentCode: string,
  failedEdits: SimulationEdit[],
  contextLine: string
): string {
  const failedList = failedEdits.map((e, i) => `[${i + 1}] old_code: "${truncForEdit(e.old_code)}"`).join('\n');
  return `These edits failed because old_code was not found in the code:
${failedList}

Here is the current code again. Provide corrected edits with old_code that exactly matches substrings in this code:
\`\`\`javascript
${currentCode}
\`\`\`

${contextLine}`;
}

/**
 * Builds the conversational history string used when editing simulations.
 *
 * Token usage safeguards:
 * - Only successful, non-pending edits are included.
 * - Only the last 10 such edits are used.
 * - Each user request and explanation is truncated to a bounded length.
 */
function buildSimEditHistoryContext(
  editHistory?: SimEditHistoryItem[]
): string {
  if (!editHistory || editHistory.length === 0) {
    return '';
  }

  const previousEdits = editHistory
    .filter(item => !item.pending && item.success)
    .slice(-10) // Limit to last 10 edits to manage token cost
    .map((item, index) => {
      const userText = truncForEdit(item.userRequest, 300);
      const explanationText = truncForEdit(item.explanation, 600);

      return `Previous Edit ${index + 1}:
User: ${userText}
Assistant: ${explanationText}`;
    })
    .join('\n\n');

  if (!previousEdits) {
    return '';
  }

  return `

PREVIOUS EDIT HISTORY (for context):
${previousEdits}

---`;
}

function applySimulationEdits(
  code: string,
  edits: SimulationEdit[]
): { newCode: string; failedEdits: SimulationEdit[] } {
  let currentCode = code;
  const failedEdits: SimulationEdit[] = [];

  for (const edit of edits) {
    const { old_code, new_code } = edit;
    if (!currentCode.includes(old_code)) {
      failedEdits.push(edit);
      continue;
    }
    // Use replaceAll to fix ALL occurrences (critical for repeated error patterns)
    currentCode = currentCode.replaceAll(old_code, new_code);
  }

  return { newCode: currentCode, failedEdits };
}

export const editSimulationCode = async (
  currentCode: string,
  currentParams: ControlParam[],
  userRequest: string,
  editHistory?: SimEditHistoryItem[]
): Promise<InteractiveConfig & { explanation: string }> => {
  const schema = SIMULATION_PATCH_RESPONSE_SCHEMA;

  const systemPrompt = `You are a code editor for React Three Fiber simulations. The user will request changes to an existing simulation.

Your tool is search-and-replace. You MUST output edits as an array of {old_code, new_code} pairs.
- old_code: An EXACT substring that appears in the current code (copy it precisely, including whitespace)
- new_code: The replacement string

RULES:
1. NEVER output the full code. Only output the minimal edits needed.
2. Match exact substrings — old_code must exist verbatim in the code.
3. If adding a new slider/toggle/button, update the params array. Use the same structure as existing params.
4. Keep edits minimal and precise. One edit per logical change.
5. For geometry changes (e.g. "make balls bigger"), find the geometry args and change the numeric values.
6. For new controls, add to params AND add code that reads params.<name> in the simulation.
7. If previous edit history is provided, use it for context to understand the sequence of changes and avoid conflicts.`;

  const paramsJson = JSON.stringify(currentParams, null, 2);
  const historyContext = buildSimEditHistoryContext(editHistory);

  const userPrompt = `Current simulation code:
\`\`\`javascript
${currentCode}
\`\`\`

Current controls (params):
${paramsJson}${historyContext}

User request: ${userRequest}

Output your edits. Remember: old_code must be an EXACT substring from the code above.`;

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt }
  ];

  let result: SimulationEditResult = await callLLM(messages, schema, "simulation_edit_schema", "fast");
  const edits = Array.isArray(result.edits) ? result.edits : [];
  let { newCode, failedEdits } = applySimulationEdits(currentCode, edits);

  if (failedEdits.length > 0) {
    const retryPrompt = buildFailedEditsRetryPrompt(currentCode, failedEdits, `Original user request: ${userRequest}`);
    // Include conversation history in retry messages too
    const retryMessages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
      { role: "user", content: retryPrompt }
    ];
    const retryResult: SimulationEditResult = await callLLM(
      retryMessages,
      schema, "simulation_edit_retry_schema", "fast"
    );
    const retryEdits = Array.isArray(retryResult.edits) ? retryResult.edits : [];
    const retryApply = applySimulationEdits(currentCode, retryEdits);
    if (retryApply.failedEdits.length > 0) {
      throw new Error(
        `Could not apply edits. These old_code strings were not found: ${retryApply.failedEdits.map(e => JSON.stringify(e.old_code)).join(', ')}`
      );
    }
    newCode = retryApply.newCode;
    result = retryResult;
  }

  const cleanCode = sanitizeSimulationCode(newCode);
  const safeParams = Array.isArray(result.params) ? result.params : currentParams;
  return {
    prompt: "User edit: " + userRequest,
    code: cleanCode,
    params: safeParams,
    explanation: result.explanation
  };
};

// 3e. Fix Simulation Code via Patch (Error Correction with Flash model)
export const fixSimulationCodeWithPatch = async (
  currentCode: string,
  currentParams: ControlParam[],
  errorMessage: string,
  errorStack?: string,
  validationWarnings?: string[],
  sectionId?: number
): Promise<InteractiveConfig & { explanation: string }> => {
  // Budget check — throws if over session or per-section limit
  consumeErrorCorrectionBudget(sectionId);

  const schema = SIMULATION_PATCH_RESPONSE_SCHEMA;

  const systemPrompt = `You are a code editor for React Three Fiber simulations specializing in ERROR CORRECTION.

A runtime error occurred in the simulation code. Your task is to produce MINIMAL search-and-replace patches to fix it.

Your tool is search-and-replace. You MUST output edits as an array of {old_code, new_code} pairs.
- old_code: An EXACT substring that appears in the current code (copy it precisely, including whitespace)
- new_code: The replacement string that fixes the error

CRITICAL RULES:
1. NEVER output the full code. Only output the MINIMAL edits needed to fix the error.
2. Match exact substrings — old_code must exist verbatim in the code.
3. Analyze the error message and identify which of the common patterns below caused it.
4. Keep edits surgical and precise. Only change what's broken.
5. If the fix requires param changes (rare), update the params array.

${R3F_ERROR_PATTERNS}

ADDITIONAL RULES:
- Identify the specific error pattern from the list above
- Locate the problematic code section
- Create minimal edits that fix ONLY the error
- Preserve all working functionality
- Do NOT refactor or improve code that isn't broken`;

  const paramsJson = JSON.stringify(currentParams, null, 2);

  const validationWarningsText = validationWarnings && validationWarnings.length > 0
    ? `\n\nPRE-EXECUTION VALIDATION WARNINGS (Static Analysis):
${validationWarnings.map((w, i) => `${i + 1}. ${w}`).join('\n')}

NOTE: These warnings were detected BEFORE execution. The runtime error likely stems from one of these issues.`
    : '';

  const userPrompt = `Current simulation code that produced an error:
\`\`\`javascript
${currentCode}
\`\`\`

Current controls (params):
${paramsJson}

RUNTIME ERROR:
${errorMessage}

${errorStack ? `ERROR STACK TRACE:\n${errorStack.substring(0, 500)}` : ''}${validationWarningsText}

Analyze the error, identify which common pattern above caused it, and output minimal patches to fix it. Remember: old_code must be an EXACT substring from the code above.`;

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt }
  ];

  let result: SimulationEditResult = await callLLM(messages, schema, "simulation_error_fix_schema", "fast");
  const edits = Array.isArray(result.edits) ? result.edits : [];
  let { newCode, failedEdits } = applySimulationEdits(currentCode, edits);

  // Retry if any edits failed to apply
  if (failedEdits.length > 0) {
    const retryPrompt = buildFailedEditsRetryPrompt(currentCode, failedEdits, `Original error: ${errorMessage}`);
    const retryResult: SimulationEditResult = await callLLM(
      [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }, { role: "user", content: retryPrompt }],
      schema, "simulation_error_fix_retry_schema", "fast"
    );
    const retryEdits = Array.isArray(retryResult.edits) ? retryResult.edits : [];
    const retryApply = applySimulationEdits(currentCode, retryEdits);
    if (retryApply.failedEdits.length > 0) {
      throw new Error(
        `Could not apply error fixes. These old_code strings were not found: ${retryApply.failedEdits.map(e => JSON.stringify(e.old_code)).join(', ')}`
      );
    }
    newCode = retryApply.newCode;
    result = retryResult;
  }

  const cleanCode = sanitizeSimulationCode(newCode);
  const safeParams = Array.isArray(result.params) ? result.params : currentParams;

  // VALIDATE the corrected code before returning
  const validation = validateSimulationCode(cleanCode);

  // Log warnings
  if (validation.warnings && validation.warnings.length > 0) {
    console.warn('[ERROR FIX] Corrected code has warnings:', validation.warnings);
  }

  if (!validation.valid) {
    console.warn('[ERROR FIX] Corrected code still has validation errors:', validation.errors);

    // Re-attempt correction with validation errors
    const validationErrorMsg = validation.errors
      .map(e => `Line ${e.line}: ${e.message}`)
      .join('; ');

    throw new Error(
      `Error correction failed validation: ${validationErrorMsg}. ` +
      `Original error: ${errorMessage}`
    );
  }

  console.log('[ERROR FIX] Corrected code passed validation ✓');
  console.log('[ERROR FIX] Applied patch-based error correction');

  return {
    prompt: "Error fix: " + errorMessage,
    code: cleanCode,
    params: safeParams,
    explanation: result.explanation
  };
};

// 3c. Generate Interactive Code with Automatic Retry on Error
export const generateInteractiveCodeWithRetry = async (
  topic: string,
  sectionTitle: string,
  simulationDescription: string,
  previousContext: string,
  currentSlidesContext: string,
  sectionNumber: number,
  level: LearningLevel,
  onAttempt?: (attempt: number, code: string) => void
): Promise<InteractiveConfig> => {
  console.log('[RETRY WRAPPER] Starting code generation with retry capability');
  
  // First attempt - normal generation
  console.log('[RETRY WRAPPER] Attempt 1: Normal generation');
  const firstAttempt = await generateInteractiveCode(
    topic,
    sectionTitle,
    simulationDescription,
    previousContext,
    currentSlidesContext,
    sectionNumber,
    level
  );

  // Notify caller of first attempt
  onAttempt?.(1, firstAttempt.code);

  // Return the first attempt - error detection will happen at runtime
  // If an error occurs, the parent component will need to call the error correction directly
  return firstAttempt;
};

// 4. Generate Quiz - NOW with slides and interactive context
export const generateQuiz = async (
  topic: string,
  sectionTitle: string,
  previousContext: string,
  currentSlidesContext: string,
  interactiveContext: string,
  sectionNumber: number,
  level: LearningLevel = 'highschool'  // Learning level
): Promise<QuizQuestion[]> => {
  const schema = {
    type: "object",
    properties: {
      questions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "integer" },
            question: { type: "string" },
            options: {
              type: "array",
              items: { type: "string" },
            },
            correctAnswerIndex: { type: "integer", description: "0-based index of the correct option" },
          },
          required: ["id", "question", "options", "correctAnswerIndex"],
          additionalProperties: false,
        },
      },
    },
    required: ["questions"],
    additionalProperties: false,
  };

  const levelInstructions = getLevelInstructions(level);

  const systemPrompt = `
You are an expert educational quiz creator.

${levelInstructions}

QUIZ DIFFICULTY BASED ON LEVEL:
- Beginner: Simple recall and basic understanding. Use simple language. Avoid math in questions.
- High School: Test understanding of key formulas and concepts. Include some calculation-based questions.
- Undergraduate: Test deeper understanding and application. Include derivation-based or analytical questions.
- Graduate: Test advanced concepts, edge cases, and research-level understanding.

PREVIOUS SECTIONS (What student already learned - DO NOT ask about these):
${previousContext}

CURRENT SECTION SLIDES (Test comprehension of THIS content):
${currentSlidesContext}

CURRENT SECTION'S 3D SIMULATION:
${interactiveContext}

=== CRITICAL: WHAT TO ASK vs WHAT NOT TO ASK ===

GOOD QUESTIONS - Test the SUBJECT MATTER:
- "What happens to the pendulum's period if you double the length?"
- "Which force causes the pendulum to swing back toward center?"
- "In the simulation, what did you observe when increasing the mass?"
- "What is the formula for the period of a simple pendulum?"
- "Why does a longer pendulum swing more slowly?"

BAD QUESTIONS - NEVER ask these (meta/pedagogical/self-referential):
- "How does this section help you for later lessons?" ❌
- "Why is the simulation useful for learning?" ❌
- "What is the purpose of this course section?" ❌
- "How does this build on previous knowledge?" ❌
- "Why did we include this topic in the curriculum?" ❌

The student is here to LEARN THE SUBJECT, not to reflect on course design!

INSTRUCTIONS:
- Create questions that test understanding of the ACTUAL CONCEPTS taught (physics, math, science, etc.)
- Questions should have clear, factual correct answers based on the content
- One question can ask what they observed/learned from the 3D simulation's behavior
- Match question difficulty to the TARGET AUDIENCE level specified above
- Do NOT ask meta-questions about the course structure, pedagogy, or learning journey
- Do NOT repeat questions that were already asked in previous sections
`;

  const messages = [
    {
      role: "system",
      content: systemPrompt
    },
    {
      role: "user",
      content: `Create a 3-question quiz for Section ${sectionNumber}: "${sectionTitle}" of the topic "${topic}".

The questions should test the student's understanding of:
1. The KEY CONCEPTS and FACTS explained in the slides (e.g., formulas, definitions, principles)
2. What PHYSICAL/SCIENTIFIC BEHAVIOR the 3D simulation demonstrates
3. Application or deeper understanding of the topic

IMPORTANT: Ask about the SUBJECT MATTER (${topic}), NOT about the course structure or learning process.
Each question should have ONE clearly correct answer based on the content taught.`
    }
  ];

  const data = await callLLM(messages, schema, "quiz_schema", "fast");
  
  return data.questions;
};

// ============================================================================
// Voice Bot - Speaker Notes Generation
// ============================================================================

// Available TTS voices from Gemini
export const TTS_VOICES = [
  { name: 'Charon', description: 'Informative' },
  { name: 'Kore', description: 'Firm' },
  { name: 'Puck', description: 'Upbeat' },
  { name: 'Fenrir', description: 'Excitable' },
  { name: 'Aoede', description: 'Breezy' },
  { name: 'Enceladus', description: 'Breathy' },
  { name: 'Iapetus', description: 'Clear' },
  { name: 'Achernar', description: 'Soft' },
  { name: 'Gacrux', description: 'Mature' },
  { name: 'Achird', description: 'Friendly' },
  { name: 'Sadaltager', description: 'Knowledgeable' },
  { name: 'Sulafat', description: 'Warm' },
] as const;

export type TTSVoiceName = typeof TTS_VOICES[number]['name'];

/**
 * Generate conversational speaker notes from slide content
 * These notes are optimized for text-to-speech narration
 */
export const generateSpeakerNotes = async (
  slideTitle: string,
  slideContent: string,
  topic: string,
  level: LearningLevel = 'highschool'
): Promise<string> => {
  const schema = {
    type: "object",
    properties: {
      speakerNotes: {
        type: "string",
        description: "Conversational narration of the slide content, optimized for spoken delivery"
      }
    },
    required: ["speakerNotes"],
    additionalProperties: false,
  };

  const levelInstructions = getLevelInstructions(level);

  const systemPrompt = `You are an expert educational narrator creating spoken explanations for an interactive learning platform.

${levelInstructions}

Your task is to convert slide content into natural, conversational speaker notes that will be read aloud by a text-to-speech system.

GUIDELINES FOR SPEAKER NOTES:
1. Write in a conversational, engaging tone as if speaking directly to the student
2. Start with a brief introduction like "In this slide, we'll explore..." or "Let's look at..."
3. Explain concepts clearly and simply - remember this will be SPOKEN, not read
4. Avoid overly technical jargon unless explaining it
5. Use natural transitions and pauses (commas indicate brief pauses)
6. Keep sentences relatively short for better TTS delivery
7. Do NOT include bullet points, numbered lists, or formatting markers
8. Do NOT include LaTeX math notation - spell out equations verbally (e.g., "E equals m c squared")
9. Do NOT include HTML tags or any markup
10. Aim for 100-200 words - enough to explain but not too long to listen to
11. End with a brief summary or transition to encourage exploration

EXAMPLE INPUT:
Title: "Newton's First Law"
Content: "<p>An object at rest stays at rest...</p><p>Formula: $F = ma$</p>"

EXAMPLE OUTPUT:
"In this slide, we're exploring Newton's First Law of Motion. This fundamental principle tells us that an object at rest will stay at rest, and an object in motion will keep moving at the same speed and direction, unless an outside force acts on it. Think about a hockey puck on ice - once you hit it, it keeps sliding until friction slows it down. The key equation here is F equals m times a, which tells us that force equals mass times acceleration. Try adjusting the simulation to see how different forces affect motion!"`;

  // Strip HTML tags from slide content for cleaner input
  const cleanContent = slideContent.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

  const messages = [
    {
      role: "system",
      content: systemPrompt
    },
    {
      role: "user",
      content: `Generate speaker notes for the following slide:

Topic: ${topic}
Slide Title: ${slideTitle}
Slide Content: ${cleanContent}

Create conversational, engaging speaker notes that explain this content in a natural speaking style.`
    }
  ];

  const data = await callLLM(messages, schema, "speaker_notes_schema", "fast");

  return data.speakerNotes;
};

// ============================================================================
// Voice Bot - Text-to-Speech Generation (Gemini TTS)
// ============================================================================

// NOTE: TTS model remains unchanged - gemini-2.5-flash-preview-tts is the specialized TTS model
// This is NOT changed to 3.0 Flash as it's a different model family specifically for speech synthesis
const GEMINI_TTS_MODEL = "gemini-2.5-flash-preview-tts";

/**
 * Generate speech audio from text using Gemini TTS API
 * Returns base64-encoded WAV audio data
 */
export const generateSpeechAudio = async (
  text: string,
  voiceName: TTSVoiceName = 'Charon'
): Promise<string> => {
  if (!GEMINI_API_KEY) {
    throw new Error('Gemini API key is required for TTS');
  }

  const startTime = Date.now();

  // Build the TTS request - Gemini TTS uses a different format than text generation
  const requestBody = {
    contents: [
      {
        parts: [{ text: text }]
      }
    ],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: voiceName
          }
        }
      }
    }
  };

  const response = await fetch(
    `${GEMINI_API_URL}/${GEMINI_TTS_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody)
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Gemini TTS API error: ${response.status} - ${error}`);
  }

  const data = await response.json();

  // Extract base64 audio data from response
  const audioData = data.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!audioData) {
    throw new Error('Gemini TTS API returned empty audio response');
  }

  const durationMs = Date.now() - startTime;
  console.log(`[TTS] Generated audio in ${durationMs}ms using voice: ${voiceName}`);

  return audioData;
};

/**
 * Helper to convert base64 audio to a playable Blob URL
 * Gemini TTS returns raw PCM audio at 24kHz, mono, 16-bit
 */
export const createAudioBlobUrl = (base64Audio: string): string => {
  // Decode base64 to binary
  const binaryString = atob(base64Audio);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  // Create WAV header for raw PCM data
  // Gemini TTS returns raw PCM at 24000Hz, 16-bit, mono
  const sampleRate = 24000;
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = bytes.length;
  const headerSize = 44;
  const fileSize = headerSize + dataSize - 8;

  const wavBuffer = new ArrayBuffer(headerSize + dataSize);
  const view = new DataView(wavBuffer);

  // RIFF header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, fileSize, true);
  writeString(view, 8, 'WAVE');

  // fmt subchunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
  view.setUint16(20, 1, true); // AudioFormat (1 for PCM)
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  // data subchunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // Copy PCM data
  const wavBytes = new Uint8Array(wavBuffer);
  wavBytes.set(bytes, headerSize);

  // Create blob and URL
  const blob = new Blob([wavBuffer], { type: 'audio/wav' });
  return URL.createObjectURL(blob);
};

// Helper to write string to DataView
function writeString(view: DataView, offset: number, string: string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

// ============================================================================
// Slide Chatbot — lightweight Q&A powered by fast-tier model
// ============================================================================

/**
 * Strip HTML tags from a string and return plain text.
 */
function stripHtml(html: string): string {
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return doc.body.textContent?.replace(/\s+/g, ' ').trim() || '';
  } catch {
    return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }
}

/**
 * Call Gemini for a plain-text (non-JSON-schema) chat response.
 * Uses the fast-tier model for low latency and cost.
 */
async function callGeminiChat(
  messages: Array<{ role: string; content: string }>,
  model?: string
): Promise<string> {
  const selectedModel = model || getModel('fast');

  const systemMessage = messages.find(m => m.role === 'system');
  const chatMessages = messages.filter(m => m.role !== 'system');

  const requestBody: any = {
    contents: chatMessages.map(msg => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }]
    })),
    generationConfig: {
      // Plain text — no JSON schema
      maxOutputTokens: 1024,
    }
  };

  if (systemMessage) {
    requestBody.systemInstruction = {
      parts: [{ text: systemMessage.content }]
    };
  }

  const response = await fetch(
    `${GEMINI_API_URL}/${selectedModel}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Gemini chat API error: ${response.status} - ${error}`);
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini chat returned empty response');
  return text;
}

/**
 * Build context string from slides, grouping by section.
 */
function buildSlideContext(
  contextSections: Array<{ title: string; slides: Slide[] }>,
  currentSectionTitle: string,
  currentSlideIndex: number
): string {
  const parts: string[] = [];

  for (const section of contextSections) {
    const isCurrent = section.title === currentSectionTitle;
    parts.push(`\n--- Section: ${section.title}${isCurrent ? ' (CURRENT SECTION)' : ''} ---`);

    section.slides.forEach((slide, idx) => {
      const isCurrentSlide = isCurrent && idx === currentSlideIndex;
      const prefix = isCurrentSlide ? '>>> CURRENT SLIDE <<<' : `Slide ${idx + 1}`;
      const plainContent = stripHtml(slide.content);
      parts.push(`\n[${prefix}] ${slide.title}\n${plainContent}`);
    });
  }

  return parts.join('\n');
}

/**
 * Send a chat message about slides and get an AI tutor response.
 *
 * @param userMessage - The student's question
 * @param chatHistory - Previous messages in this conversation
 * @param contextSections - Sections the student has access to (current + previous)
 * @param currentSectionTitle - Title of the section being viewed
 * @param currentSlideIndex - Index of the slide the student is on
 * @param courseTopic - The overall course topic
 * @param learningLevel - Student's learning level
 * @returns The assistant's reply text
 */
export async function chatWithSlides(
  userMessage: string,
  chatHistory: ChatMessage[],
  contextSections: Array<{ title: string; slides: Slide[] }>,
  currentSectionTitle: string,
  currentSlideIndex: number,
  courseTopic: string,
  learningLevel: LearningLevel
): Promise<string> {
  const slideContext = buildSlideContext(contextSections, currentSectionTitle, currentSlideIndex);

  const levelDescriptions: Record<LearningLevel, string> = {
    beginner: 'a young beginner (ages 10-14). Use simple language, analogies, and everyday examples. Avoid jargon.',
    highschool: 'a high-school student. Use clear explanations with foundational math (algebra, basic trig). Define technical terms.',
    undergraduate: 'a college undergraduate. You may use calculus, formal definitions, and derivations. Be rigorous but clear.',
    graduate: 'a graduate-level student. Assume strong mathematical maturity. Discuss edge cases, proofs, and research context.'
  };

  const systemPrompt = `You are a friendly, concise tutor helping a student learn about "${courseTopic}".

The student's level: ${levelDescriptions[learningLevel]}

Below is the slide content the student has covered so far. The current slide they are viewing is marked with ">>> CURRENT SLIDE <<<". Use this material as your primary knowledge source when answering questions.

${slideContext}

Guidelines:
- Answer the student's question clearly and concisely (keep responses short — 2-4 paragraphs max).
- Reference specific slides or concepts from the material when relevant.
- If the student asks about something not covered in the slides, briefly answer but note it goes beyond the current material.
- Use markdown formatting for clarity (bold, bullet points, etc.) but keep it light.
- If the question involves math, use LaTeX notation with \\( ... \\) for inline and \\[ ... \\] for block math.
- Be encouraging and supportive.`;

  // Build messages array: system + history + new user message
  const messages: Array<{ role: string; content: string }> = [
    { role: 'system', content: systemPrompt }
  ];

  // Add chat history (skip system messages, limit to last 20 messages to stay within context)
  const recentHistory = chatHistory.slice(-20);
  for (const msg of recentHistory) {
    messages.push({ role: msg.role, content: msg.content });
  }

  // Add the new user message
  messages.push({ role: 'user', content: userMessage });

  return callGeminiChat(messages);
}
