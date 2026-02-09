import React, { useMemo, useState } from 'react';
import * as THREE from 'three';
import * as Fiber from '@react-three/fiber';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, PerspectiveCamera, Environment, Grid, Text } from '@react-three/drei';
import { devLogger } from '../services/devLogger';

// Error boundary for catching runtime errors in generated code
class SimulationErrorBoundary extends React.Component<
  { children: React.ReactNode; code?: string; onError?: (error: Error) => void },
  { hasError: boolean; error: string; errorReported: boolean }
> {
  constructor(props: { children: React.ReactNode; code?: string; onError?: (error: Error) => void }) {
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
    });
    
    // Call error callback if provided and not already reported
    if (this.props.onError && !this.state.errorReported) {
      this.setState({ errorReported: true });
      // Create enhanced error with stack trace
      const enhancedError = new Error(error.message);
      enhancedError.stack = error.stack;
      enhancedError.name = error.name;
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
  onError?: (error: Error) => void;
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
          console.warn(`[ThreeSandbox] Auto-fixed: converted THREE.${child.type} instance to <${elName}> element`);
          devLogger.logAutoFix('geometry-child-to-element', `THREE.${child.type} -> <${elName}>`);
          return originalCreateElement(elName, args.length ? { args } : undefined);
        }
        // Material instance passed as a child (e.g. new THREE.MeshStandardMaterial())
        if (child.isMaterial && child.type) {
          const elName = lcFirst(child.type);
          const matProps = extractMaterialProps(child);
          console.warn(`[ThreeSandbox] Auto-fixed: converted THREE.${child.type} instance to <${elName}> element`);
          devLogger.logAutoFix('material-child-to-element', `THREE.${child.type} -> <${elName}>`);
          return originalCreateElement(elName, matProps);
        }
      }
      return child;
    });

    // --- Fix props: geometry / material passed as props on mesh elements -----
    let fixedProps = props;
    const propsChildren: any[] = [];

    if (typeof type === 'string' && type === 'mesh' && props) {
      fixedProps = { ...props };

      // geometry prop that is a non-Buffer geometry instance -> move to child
      if (fixedProps.geometry && fixedProps.geometry.isBufferGeometry &&
          fixedProps.geometry.type && fixedProps.geometry.type !== 'BufferGeometry') {
        const geo = fixedProps.geometry;
        const elName = lcFirst(geo.type);
        const args = geo.parameters ? Object.values(geo.parameters) : [];
        console.warn(`[ThreeSandbox] Auto-fixed: moved geometry prop THREE.${geo.type} to <${elName}> child`);
        devLogger.logAutoFix('geometry-prop-to-child', `THREE.${geo.type} -> <${elName}> child on mesh`);
        propsChildren.push(originalCreateElement(elName, args.length ? { args } : undefined));
        delete fixedProps.geometry;
      }

      // geometry prop that is a React element (e.g. from useMemo caching
      // React.createElement('sphereGeometry',...)) -> move to child.
      // React elements have $$typeof and a string type like 'sphereGeometry'.
      // Passing a React element as the `geometry` prop causes:
      //   "geometry.addEventListener is not a function"
      // because R3F expects a THREE.BufferGeometry, not a React element.
      if (fixedProps.geometry && typeof fixedProps.geometry === 'object' &&
          !fixedProps.geometry.isBufferGeometry &&
          (fixedProps.geometry.$$typeof || (fixedProps.geometry.type && typeof fixedProps.geometry.type === 'string'))) {
        console.warn(`[ThreeSandbox] Auto-fixed: moved React element geometry prop to child on mesh`);
        devLogger.logAutoFix('react-element-geometry-to-child', `React element (${fixedProps.geometry.type || 'unknown'}) moved from geometry prop to child`);
        propsChildren.push(fixedProps.geometry);
        delete fixedProps.geometry;
      }

      // material prop that is a Material instance -> move to child
      if (fixedProps.material && fixedProps.material.isMaterial) {
        const mat = fixedProps.material;
        const elName = lcFirst(mat.type);
        const matProps = extractMaterialProps(mat);
        console.warn(`[ThreeSandbox] Auto-fixed: moved material prop THREE.${mat.type} to <${elName}> child`);
        devLogger.logAutoFix('material-prop-to-child', `THREE.${mat.type} -> <${elName}> child on mesh`);
        propsChildren.push(originalCreateElement(elName, matProps));
        delete fixedProps.material;
      }

      // material prop that is a React element -> move to child
      if (fixedProps.material && typeof fixedProps.material === 'object' &&
          !fixedProps.material.isMaterial &&
          (fixedProps.material.$$typeof || (fixedProps.material.type && typeof fixedProps.material.type === 'string'))) {
        console.warn(`[ThreeSandbox] Auto-fixed: moved React element material prop to child on mesh`);
        devLogger.logAutoFix('react-element-material-to-child', `React element (${fixedProps.material.type || 'unknown'}) moved from material prop to child`);
        propsChildren.push(fixedProps.material);
        delete fixedProps.material;
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

// Create the safe React proxy once at module level
const SafeReact = createSafeReact();

// This component takes the code string and creates a live React component from it.
// It runs inside Canvas, so we can call useThree() once here and pass a getter to
// generated code. That way generated code can call useThree() inside loops (e.g. .map)
// without violating the Rules of Hooks (same hook count every render).
const GeneratedScene: React.FC<{ code: string; params: Record<string, number> }> = ({ code, params }) => {
  const three = useThree();
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
      
      return (props: { params: Record<string, number>; useThreeValue: ReturnType<typeof useThree> }) => {
        return func({
          React: SafeReact,   // Use safe proxy instead of raw React
          THREE,
          useFrame,
          useThree: () => props.useThreeValue,
          Text,
          params: props.params
        });
      };
    } catch (err) {
      console.error("Error compiling generated code:", err);
      devLogger.addEntry('sim-error', 'CodeCompilation', `Failed to compile generated code: ${err instanceof Error ? err.message : String(err)}`, {
        error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err),
        code: code?.substring(0, 10_000),
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

  return <Component params={params} useThreeValue={three} />;
};

export const ThreeSandbox: React.FC<ThreeSandboxProps> = ({ code, params, onError }) => {
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
        <SimulationErrorBoundary code={code} onError={onError}>
          <GeneratedScene code={code} params={params} />
        </SimulationErrorBoundary>

      </Canvas>
    </div>
  );
};