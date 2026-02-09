import React, { useMemo, useState, useEffect, useCallback } from 'react';
import * as THREE from 'three';
import * as Fiber from '@react-three/fiber';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, PerspectiveCamera, Environment, Grid, Text } from '@react-three/drei';
import { devLogger } from '../services/devLogger';
import { validateSimulationCode } from '../utils/codeValidator';

// Error boundary for catching runtime errors in generated code
class SimulationErrorBoundary extends React.Component<
  { children: React.ReactNode; code?: string; onError?: (error: Error) => void; validationWarnings?: string[] },
  { hasError: boolean; error: string; errorReported: boolean }
> {
  constructor(props: { children: React.ReactNode; code?: string; onError?: (error: Error) => void; validationWarnings?: string[] }) {
    super(props);
    this.state = { hasError: false, error: '', errorReported: false };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error: error.message };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('Simulation Error:', error, errorInfo);

    // Log to devLogger with full context
    devLogger.addEntry('sim-error', 'ErrorBoundary', `Caught: ${error.message}`, {
      errorName: error.name,
      errorMessage: error.message,
      errorStack: error.stack,
      componentStack: errorInfo.componentStack,
      code: this.props.code?.substring(0, 10_000),
      validationWarnings: this.props.validationWarnings,
    });

    // Call error callback if provided and not already reported
    if (this.props.onError && !this.state.errorReported) {
      this.setState({ errorReported: true });
      // Create enhanced error with stack trace AND validation warnings
      const enhancedError = new Error(error.message) as Error & { validationWarnings?: string[] };
      enhancedError.stack = error.stack;
      enhancedError.name = error.name;
      enhancedError.validationWarnings = this.props.validationWarnings;
      this.props.onError(enhancedError);
    }
  }

  // Reset error state when code changes (allows retry with new code)
  componentDidUpdate(prevProps: { code?: string }) {
    if (prevProps.code !== this.props.code && this.state.hasError) {
      this.setState({ hasError: false, error: '', errorReported: false });
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <group>
          <mesh position={[0, 0, 0]}>
            <boxGeometry args={[2, 2, 2]} />
            <meshStandardMaterial color="#ff4444" wireframe />
          </mesh>
          <Text position={[0, 2.5, 0]} fontSize={0.35} color="#ff6b6b" anchorX="center">
            Simulation Error
          </Text>
          <Text position={[0, 1.8, 0]} fontSize={0.18} color="#ffaa88" anchorX="center" maxWidth={6}>
            {this.state.error.substring(0, 100)}
          </Text>
          <Text position={[0, 1.2, 0]} fontSize={0.15} color="#888" anchorX="center" maxWidth={6}>
            Check console for details
          </Text>
        </group>
      );
    }
    return this.props.children;
  }
}

declare global {
  namespace JSX {
    interface IntrinsicElements {
      group: any;
      mesh: any;
      // Geometries
      boxGeometry: any;
      sphereGeometry: any;
      cylinderGeometry: any;
      coneGeometry: any;
      planeGeometry: any;
      torusGeometry: any;
      circleGeometry: any;
      tubeGeometry: any;
      ringGeometry: any;
      torusKnotGeometry: any;
      // Materials
      meshBasicMaterial: any;
      meshStandardMaterial: any;
      meshPhongMaterial: any;
      lineBasicMaterial: any;
      lineDashedMaterial: any;
      pointsMaterial: any;
      // Lines and Points
      line: any;
      lineSegments: any;
      points: any;
      // Lights
      ambientLight: any;
      directionalLight: any;
      pointLight: any;
      spotLight: any;
      // Helpers
      axesHelper: any;
      gridHelper: any;
      arrowHelper: any;
    }
  }
}

interface ThreeSandboxProps {
  code: string;
  params: Record<string, number>;
  sectionId: number; // Section ID to prevent race conditions
  onError?: (error: Error, sectionId: number) => void;
}

// ============================================================================
// Runtime Safety Layer: intercepts THREE.js objects incorrectly passed as
// React children or props and converts them to proper R3F React elements.
// This catches the common AI-generation error:
//   "Objects are not valid as a React child (found: object with keys {isBufferGeometry, ...})"
// ============================================================================

/** Lower-case the first character: "BoxGeometry" -> "boxGeometry" */
function lcFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/** Extract serialisable props from a THREE.js Material instance */
function extractMaterialProps(mat: any): Record<string, any> {
  const props: Record<string, any> = {};
  if (mat.color && typeof mat.color.getHexString === 'function') {
    props.color = '#' + mat.color.getHexString();
  }
  if (mat.wireframe !== undefined) props.wireframe = mat.wireframe;
  if (mat.transparent !== undefined) props.transparent = mat.transparent;
  if (mat.opacity !== undefined && mat.opacity !== 1) props.opacity = mat.opacity;
  if (mat.side !== undefined && mat.side !== THREE.FrontSide) props.side = mat.side;
  if (mat.emissive && typeof mat.emissive.getHexString === 'function') {
    const hex = mat.emissive.getHexString();
    if (hex !== '000000') props.emissive = '#' + hex;
  }
  if (mat.emissiveIntensity !== undefined && mat.emissiveIntensity !== 1) {
    props.emissiveIntensity = mat.emissiveIntensity;
  }
  if (mat.metalness !== undefined && mat.metalness !== 0) props.metalness = mat.metalness;
  if (mat.roughness !== undefined && mat.roughness !== 1) props.roughness = mat.roughness;
  if (mat.size !== undefined) props.size = mat.size; // PointsMaterial
  if (mat.vertexColors !== undefined && mat.vertexColors) props.vertexColors = true;
  if (mat.linewidth !== undefined && mat.linewidth !== 1) props.linewidth = mat.linewidth;
  return props;
}

// 3D element types (THREE.Object3D subclasses) that may have AI-generated
// geometries without computed bounding spheres. Disabling frustum culling on
// these prevents the fatal "Cannot read properties of undefined (reading
// 'center')" error during WebGLRenderer.render → Frustum.intersectsObject.
const FRUSTUM_CULL_DISABLED_TYPES = new Set(['mesh', 'line', 'lineSegments', 'points']);

// --------------- Auto-fix log deduplication ---------------
// Prevents thousands of identical warnings when safeCreateElement fires every frame.
const autoFixCounts = new Map<string, number>();

function logAutoFixOnce(type: string, details: string) {
  const key = `${type}::${details}`;
  const prev = autoFixCounts.get(key) ?? 0;
  autoFixCounts.set(key, prev + 1);
  if (prev === 0) {
    // First occurrence — log normally
    console.warn(`[ThreeSandbox] Auto-fixed: ${details}`);
    devLogger.logAutoFix(type, details);
  }
  // Subsequent duplicates are silently counted
}

function resetAutoFixCounts() {
  autoFixCounts.clear();
}

/**
 * Build a safe React-like object whose createElement intercepts THREE.js
 * geometry / material instances that the AI accidentally passes as React
 * children or mesh props, and converts them to proper R3F declarative elements.
 *
 * Also automatically disables frustum culling on 3D object elements to prevent
 * crashes from uncomputed bounding spheres in dynamically generated geometries.
 */
function createSafeReact() {
  // Keep original createElement reference to avoid recursion
  const originalCreateElement = React.createElement;

  function safeCreateElement(type: any, props: any, ...children: any[]): any {
    // --- Fix children: convert THREE geometry / material instances -----------
    const fixedChildren = children.map((child) => {
      if (child && typeof child === 'object') {
        // Geometry instance passed as a child (e.g. new THREE.BoxGeometry())
        if (child.isBufferGeometry && child.type && child.type !== 'BufferGeometry') {
          const elName = lcFirst(child.type);
          const args = child.parameters ? Object.values(child.parameters) : [];
          logAutoFixOnce('geometry-child-to-element', `converted THREE.${child.type} instance to <${elName}> element`);
          return originalCreateElement(elName, args.length ? { args } : undefined);
        }
        // Material instance passed as a child (e.g. new THREE.MeshStandardMaterial())
        if (child.isMaterial && child.type) {
          const elName = lcFirst(child.type);
          const matProps = extractMaterialProps(child);
          logAutoFixOnce('material-child-to-element', `converted THREE.${child.type} instance to <${elName}> element`);
          return originalCreateElement(elName, matProps);
        }
      }
      return child;
    });

    // --- Fix props: React elements incorrectly passed as geometry/material props ---
    // NOTE: THREE.js geometry/material INSTANCES as props are VALID in R3F and must
    // NOT be converted — R3F handles them natively, and converting would destroy
    // post-construction modifications (.rotateX(), .setAttribute(), custom attributes).
    // Only React ELEMENTS passed as geometry/material props need fixing.
    let fixedProps = props;
    const propsChildren: any[] = [];
    const GEOMETRY_PROP_TYPES = new Set(['mesh', 'line', 'lineSegments', 'points']);

    if (typeof type === 'string' && GEOMETRY_PROP_TYPES.has(type) && props) {
      fixedProps = { ...props };

      // geometry prop that is a React element (e.g. from useMemo returning
      // React.createElement('sphereGeometry',...)) -> move to child.
      // React elements have $$typeof and a string type like 'sphereGeometry'.
      // Passing a React element as the `geometry` prop causes:
      //   "geometry.addEventListener is not a function"
      // because R3F expects a THREE.BufferGeometry, not a React element.
      if (fixedProps.geometry && typeof fixedProps.geometry === 'object' &&
          !fixedProps.geometry.isBufferGeometry &&
          (fixedProps.geometry.$$typeof || (fixedProps.geometry.type && typeof fixedProps.geometry.type === 'string'))) {
        logAutoFixOnce('react-element-geometry-to-child', `moved React element geometry (${fixedProps.geometry.type || 'unknown'}) prop to child`);
        propsChildren.push(fixedProps.geometry);
        delete fixedProps.geometry;
      }

      // material prop that is a React element -> move to child
      if (fixedProps.material && typeof fixedProps.material === 'object' &&
          !fixedProps.material.isMaterial &&
          (fixedProps.material.$$typeof || (fixedProps.material.type && typeof fixedProps.material.type === 'string'))) {
        logAutoFixOnce('react-element-material-to-child', `moved React element material (${fixedProps.material.type || 'unknown'}) prop to child`);
        propsChildren.push(fixedProps.material);
        delete fixedProps.material;
      }
    }

    // --- Wrap event handler props (onClick, onPointerOver, etc.) with try-catch ---
    // Event handlers run in browser event dispatch, outside React's render phase,
    // so error boundaries can't catch them. We wrap to report errors once.
    if (fixedProps && simErrorHandlerRef.current) {
      const handlerKeys = Object.keys(fixedProps).filter(k => /^on[A-Z]/.test(k) && typeof fixedProps[k] === 'function');
      if (handlerKeys.length > 0) {
        fixedProps = { ...fixedProps };
        for (const key of handlerKeys) {
          const original = fixedProps[key];
          fixedProps[key] = (...args: any[]) => {
            try {
              return original(...args);
            } catch (err) {
              if (!simErrorHandlerRef.fired && simErrorHandlerRef.current) {
                simErrorHandlerRef.fired = true;
                const error = err instanceof Error ? err : new Error(String(err));
                console.error(`[SIMULATION ${key} ERROR]`, error);
                devLogger.addEntry('sim-error', 'EventHandlerError', `Caught in ${key}: ${error.message}`);
                simErrorHandlerRef.current(error);
              }
            }
          };
        }
      }
    }

    // --- Disable frustum culling on 3D object types to prevent crashes from
    //     uncomputed bounding spheres in AI-generated geometries ---------------
    if (typeof type === 'string' && FRUSTUM_CULL_DISABLED_TYPES.has(type)) {
      fixedProps = { ...(fixedProps || {}), frustumCulled: false };
    }

    return originalCreateElement(type, fixedProps, ...propsChildren, ...fixedChildren);
  }

  // Return a proxy that mirrors all of React but overrides createElement
  return new Proxy(React, {
    get(target, prop) {
      if (prop === 'createElement') return safeCreateElement;
      return (target as any)[prop];
    }
  });
}

// Module-level ref for the current simulation's error handler.
// Set by GeneratedScene before render, used by SafeReact to wrap event handlers.
// This avoids recreating the proxy per-render while still routing errors correctly.
const simErrorHandlerRef: { current: ((error: Error) => void) | null; fired: boolean } = { current: null, fired: false };

// Create the safe React proxy once at module level
const SafeReact = createSafeReact();

// This component takes the code string and creates a live React component from it.
// It runs inside Canvas, so we can call useThree() once here and pass a getter to
// generated code. That way generated code can call useThree() inside loops (e.g. .map)
// without violating the Rules of Hooks (same hook count every render).
const GeneratedScene: React.FC<{
  code: string;
  params: Record<string, number>;
  onError?: (error: Error) => void;
  onValidationWarnings?: (warnings: string[]) => void;
}> = ({ code, params, onError, onValidationWarnings }) => {
  const three = useThree();
  const [validationState, setValidationState] = useState<'validating' | 'valid' | 'invalid'>('validating');
  const validationWarningsRef = React.useRef<string[]>([]);
  const useFrameErrorRef = React.useRef<boolean>(false);

  // Reset useFrame error state and auto-fix log counts when code changes (new code = new chance)
  useEffect(() => {
    useFrameErrorRef.current = false;
    resetAutoFixCounts();
  }, [code]);

  // Pre-validate code before execution
  useEffect(() => {
    setValidationState('validating');

    // Validate code for static errors
    const validation = validateSimulationCode(code);

    // Store warnings for later use in error correction
    validationWarningsRef.current = validation.warnings || [];

    // Notify parent of warnings
    onValidationWarnings?.(validationWarningsRef.current);

    // Log warnings (potential issues that won't prevent execution)
    if (validation.warnings && validation.warnings.length > 0) {
      console.warn('[VALIDATION] Pre-execution warnings:', validation.warnings);
      devLogger.addEntry('warn', 'SimValidation',
        `Found ${validation.warnings.length} warning(s) before execution`,
        {
          warnings: validation.warnings,
          code: code?.substring(0, 1000) // First 1000 chars for context
        }
      );
    }

    if (!validation.valid) {
      console.warn('[VALIDATION] Pre-execution errors found:', validation.errors);

      // Log to devLogger
      devLogger.addEntry('error', 'SimValidation',
        `Found ${validation.errors.length} error(s) before execution - triggering correction`,
        {
          errors: validation.errors,
          code: code?.substring(0, 10_000)
        }
      );

      // Trigger error correction WITHOUT executing broken code
      const errorMessage = validation.errors
        .map(e => `Line ${e.line}: ${e.message}`)
        .join('\n');

      // Attach warnings to error for context
      const enhancedError = new Error(errorMessage) as Error & { validationWarnings?: string[] };
      enhancedError.validationWarnings = validationWarningsRef.current;

      if (onError) {
        onError(enhancedError);
      }
      setValidationState('invalid');
      return;
    }

    console.log('[VALIDATION] Code passed pre-execution validation ✓');
    setValidationState('valid');
  }, [code, onError, onValidationWarnings]);

  const Component = useMemo(() => {
    try {
      // We wrap the code in a function constructor to create a component
      // We expose SafeReact (intercepting createElement) instead of raw React,
      // along with THREE, Fiber hooks, and the Text component.
      const body = `
        const { React, THREE, useFrame, useThree, Text, params } = args;
        ${code}
      `;

      // eslint-disable-next-line no-new-func
      const func = new Function('args', body);

      return (props: { params: Record<string, number>; useThreeValue: ReturnType<typeof useThree>; onUseFrameError: (error: Error) => void; useFrameErrorRef: React.MutableRefObject<boolean> }) => {
        // Wrap useFrame to catch errors in the animation loop.
        // React error boundaries can't catch useFrame errors since they run
        // in requestAnimationFrame, not in React's render phase.
        const safeUseFrame: typeof useFrame = (callback, priority) => {
          return useFrame((state, delta, frame) => {
            // Stop calling the callback after an error to prevent spam
            if (props.useFrameErrorRef.current) return;
            try {
              callback(state, delta, frame);
            } catch (err) {
              if (!props.useFrameErrorRef.current) {
                props.useFrameErrorRef.current = true;
                const error = err instanceof Error ? err : new Error(String(err));
                console.error('[SIMULATION useFrame ERROR]', error);
                devLogger.addEntry('sim-error', 'UseFrameError', `Caught in useFrame: ${error.message}`, {
                  errorName: error.name,
                  errorMessage: error.message,
                  errorStack: error.stack,
                });
                props.onUseFrameError(error);
              }
            }
          }, priority);
        };

        // Set module-level error handler for SafeReact event handler wrapping
        simErrorHandlerRef.current = props.onUseFrameError;
        simErrorHandlerRef.fired = props.useFrameErrorRef.current;

        const result = func({
          React: SafeReact,   // Use safe proxy instead of raw React
          THREE,
          useFrame: safeUseFrame,
          useThree: () => props.useThreeValue,
          Text,
          params: props.params
        });

        // Guard: if the generated code returned nothing (undefined/null), it's
        // almost certainly a missing `return` statement. new Function() doesn't
        // auto-return the last expression, and React 19 silently accepts
        // undefined (renders blank). Report as an error so the retry/correction
        // flow can ask Gemini to add the missing return.
        if (result === undefined || result === null) {
          if (!props.useFrameErrorRef.current) {
            props.useFrameErrorRef.current = true;
            const error = new Error(
              'Component returned nothing (undefined). ' +
              'The code body is missing a `return` statement before the final React.createElement() call.'
            );
            console.error('[SIMULATION RENDER ERROR]', error.message);
            devLogger.addEntry('sim-error', 'MissingReturn', error.message);
            props.onUseFrameError(error);
          }
          return null;
        }

        return result;
      };
    } catch (err) {
      console.error("Error compiling generated code:", err);
      devLogger.addEntry('sim-error', 'CodeCompilation', `Failed to compile generated code: ${err instanceof Error ? err.message : String(err)}`, {
        error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err),
        code: code?.substring(0, 10_000),
        validationWarnings: validationWarningsRef.current,
      });
      return () => (
        <group>
          <mesh>
             <boxGeometry />
             <meshBasicMaterial color="red" wireframe />
          </mesh>
        </group>
      );
    }
  }, [code]);

  // Only render if validation passed
  if (validationState === 'validating') {
    return null; // Brief loading state during validation
  }

  if (validationState === 'invalid') {
    return null; // Don't render broken code, error correction is triggered
  }

  return <Component params={params} useThreeValue={three} onUseFrameError={onError || (() => {})} useFrameErrorRef={useFrameErrorRef} />;
};

export const ThreeSandbox: React.FC<ThreeSandboxProps> = ({ code, params, sectionId, onError }) => {
  const [validationWarnings, setValidationWarnings] = useState<string[]>([]);

  // Wrap onError to include sectionId
  const handleError = useCallback((error: Error) => {
    onError?.(error, sectionId);
  }, [onError, sectionId]);

  return (
    <div className="w-full h-full rounded-lg overflow-hidden shadow-inner three-sandbox">
      <Canvas shadows>
        <PerspectiveCamera makeDefault position={[8, 6, 8]} fov={50} />
        <OrbitControls makeDefault />

        {/* Clean lighting setup */}
        <ambientLight intensity={0.5} />
        <directionalLight
          position={[10, 15, 10]}
          intensity={1.0}
          castShadow
          shadow-mapSize={[1024, 1024]}
        />
        <directionalLight
          position={[-5, 5, -5]}
          intensity={0.3}
        />

        {/* Subtle environment lighting for better materials */}
        <Environment preset="night" />

        {/* The AI Generated Content */}
        <SimulationErrorBoundary code={code} onError={handleError} validationWarnings={validationWarnings}>
          <GeneratedSceneWithWarnings
            code={code}
            params={params}
            onError={handleError}
            onValidationWarnings={setValidationWarnings}
          />
        </SimulationErrorBoundary>

      </Canvas>
    </div>
  );
};

// Wrapper component to lift validation warnings to parent
const GeneratedSceneWithWarnings: React.FC<{
  code: string;
  params: Record<string, number>;
  onError?: (error: Error) => void;
  onValidationWarnings: (warnings: string[]) => void;
}> = ({ code, params, onError, onValidationWarnings }) => {
  return (
    <GeneratedScene
      code={code}
      params={params}
      onError={onError}
      onValidationWarnings={onValidationWarnings}
    />
  );
};