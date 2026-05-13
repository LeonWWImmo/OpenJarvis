import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { createNoise3D } from 'simplex-noise';
import * as THREE from 'three';
import { useAppStore } from '../../lib/store';

type OrbRefs = {
  activity: React.MutableRefObject<number>;
  voice: React.MutableRefObject<number>;
};

const TWO_PI = Math.PI * 2;

function JarvisStarfield({ activity, voice }: OrbRefs) {
  const pointsRef = useRef<THREE.Points>(null);
  const { positions, colors } = useMemo(() => {
    const count = 850;
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const cyan = new THREE.Color('#38f4ff');
    const blue = new THREE.Color('#0b4f91');
    const gold = new THREE.Color('#ffbf4d');

    for (let i = 0; i < count; i += 1) {
      const radius = 5.6 + Math.random() * 7.4;
      const theta = Math.random() * TWO_PI;
      const phi = Math.acos(THREE.MathUtils.randFloatSpread(2));
      pos[i * 3] = Math.cos(theta) * Math.sin(phi) * radius;
      pos[i * 3 + 1] = Math.sin(theta) * Math.sin(phi) * radius;
      pos[i * 3 + 2] = Math.cos(phi) * radius - 1.2;

      const color = (i % 11 === 0 ? gold : cyan).clone().lerp(blue, Math.random() * 0.55);
      col[i * 3] = color.r;
      col[i * 3 + 1] = color.g;
      col[i * 3 + 2] = color.b;
    }

    return { positions: pos, colors: col };
  }, []);

  useFrame((_, delta) => {
    const points = pointsRef.current;
    if (!points) return;
    const pulse = 0.035 + activity.current * 0.045 + voice.current * 0.09;
    points.rotation.y += delta * (0.025 + pulse);
    points.rotation.x = Math.sin(performance.now() * 0.000045) * 0.08;
  });

  return (
    <points ref={pointsRef}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        <bufferAttribute attach="attributes-color" args={[colors, 3]} />
      </bufferGeometry>
      <pointsMaterial
        size={0.028}
        vertexColors
        transparent
        opacity={0.72}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
}

function JarvisParticleSphere({ activity, voice }: OrbRefs) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const noise = useMemo(() => createNoise3D(), []);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const color = useMemo(() => new THREE.Color(), []);
  const directions = useMemo(() => {
    const count = 1250;
    const data = new Float32Array(count * 3);

    for (let i = 0; i < count; i += 1) {
      const k = i + 0.5;
      const phi = Math.acos(1 - (2 * k) / count);
      const theta = Math.PI * (1 + Math.sqrt(5)) * k;
      data[i * 3] = Math.cos(theta) * Math.sin(phi);
      data[i * 3 + 1] = Math.sin(theta) * Math.sin(phi);
      data[i * 3 + 2] = Math.cos(phi);
    }

    return data;
  }, []);

  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

    for (let i = 0; i < directions.length / 3; i += 1) {
      const y = directions[i * 3 + 1];
      const z = directions[i * 3 + 2];
      color
        .set('#2eeaff')
        .lerp(new THREE.Color('#ffba45'), Math.max(0, z) * 0.35)
        .lerp(new THREE.Color('#0b3d91'), Math.max(0, -y) * 0.3);
      mesh.setColorAt(i, color);
    }

    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [color, directions]);

  useFrame(({ clock }, delta) => {
    const mesh = meshRef.current;
    if (!mesh) return;

    const t = clock.elapsedTime;
    const count = directions.length / 3;
    const energy = THREE.MathUtils.clamp(activity.current + voice.current * 1.35, 0, 2.4);
    const baseRadius = 1.55 + voice.current * 0.16;

    mesh.rotation.y += delta * (0.08 + energy * 0.04);
    mesh.rotation.x = Math.sin(t * 0.14) * 0.16;
    mesh.rotation.z = Math.cos(t * 0.1) * 0.08;

    for (let i = 0; i < count; i += 1) {
      const x = directions[i * 3];
      const y = directions[i * 3 + 1];
      const z = directions[i * 3 + 2];
      const n =
        noise(x * 1.75 + t * 0.1, y * 1.75 - t * 0.07, z * 1.75 + Math.sin(t * 0.11)) *
          0.5 +
        noise(x * 4.5 - t * 0.18, y * 4.5, z * 4.5 + t * 0.11) * 0.22;
      const wave = Math.sin(i * 0.024 + t * (1.0 + energy * 0.58)) * 0.035;
      const radius = baseRadius + n * (0.34 + energy * 0.08) + wave + voice.current * 0.16;
      const size = 0.025 + Math.max(0, n) * 0.025 + voice.current * 0.018;

      dummy.position.set(x * radius, y * radius, z * radius);
      dummy.scale.setScalar(size);
      dummy.lookAt(0, 0, 0);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }

    mesh.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, directions.length / 3]}>
      <boxGeometry args={[1, 1, 1]} />
      <meshBasicMaterial
        vertexColors
        transparent
        opacity={0.92}
        toneMapped={false}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </instancedMesh>
  );
}

function JarvisCore({ activity, voice }: OrbRefs) {
  const coreRef = useRef<THREE.Mesh>(null);
  const haloRef = useRef<THREE.Mesh>(null);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const energy = activity.current + voice.current * 1.7;
    if (coreRef.current) {
      const scale = 0.5 + Math.sin(t * 1.35) * 0.025 + energy * 0.08;
      coreRef.current.scale.setScalar(scale);
      coreRef.current.rotation.y = t * 0.34;
    }
    if (haloRef.current) {
      const scale = 1.65 + Math.sin(t * 0.68) * 0.08 + energy * 0.24;
      haloRef.current.scale.setScalar(scale);
      haloRef.current.rotation.z = -t * 0.18;
    }
  });

  return (
    <>
      <mesh ref={haloRef}>
        <sphereGeometry args={[0.7, 48, 32]} />
        <meshBasicMaterial
          color="#19ddff"
          transparent
          opacity={0.08}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
      <mesh ref={coreRef}>
        <icosahedronGeometry args={[0.72, 4]} />
        <meshBasicMaterial
          color="#dffcff"
          transparent
          opacity={0.72}
          toneMapped={false}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          wireframe
        />
      </mesh>
    </>
  );
}

function JarvisOrbitRings({ activity, voice }: OrbRefs) {
  const groupRef = useRef<THREE.Group>(null);

  useFrame(({ clock }, delta) => {
    const group = groupRef.current;
    if (!group) return;
    const t = clock.elapsedTime;
    const speed = 0.1 + activity.current * 0.06 + voice.current * 0.16;
    group.rotation.y += delta * speed;
    group.rotation.x = 0.72 + Math.sin(t * 0.12) * 0.12;
    group.rotation.z = Math.sin(t * 0.09) * 0.08;
  });

  return (
    <group ref={groupRef}>
      <mesh rotation={[Math.PI / 2.8, 0.18, 0]}>
        <torusGeometry args={[2.14, 0.008, 8, 192]} />
        <meshBasicMaterial color="#35ecff" transparent opacity={0.48} blending={THREE.AdditiveBlending} />
      </mesh>
      <mesh rotation={[Math.PI / 2.15, 0.92, 0.3]}>
        <torusGeometry args={[2.48, 0.006, 8, 192]} />
        <meshBasicMaterial color="#ffbd4a" transparent opacity={0.34} blending={THREE.AdditiveBlending} />
      </mesh>
      <mesh rotation={[Math.PI / 1.75, -0.55, -0.2]}>
        <torusGeometry args={[1.72, 0.01, 8, 160]} />
        <meshBasicMaterial color="#7df9ff" transparent opacity={0.38} blending={THREE.AdditiveBlending} />
      </mesh>
    </group>
  );
}

function JarvisThreeScene({ activity, voice }: OrbRefs) {
  return (
    <>
      <ambientLight intensity={0.35} />
      <pointLight position={[2.5, 2.5, 3.2]} intensity={10} color="#6cf8ff" />
      <pointLight position={[-2.4, -1.6, 2.6]} intensity={5} color="#ffb84d" />
      <group position={[0, 0.05, 0]}>
        <JarvisStarfield activity={activity} voice={voice} />
        <JarvisOrbitRings activity={activity} voice={voice} />
        <JarvisParticleSphere activity={activity} voice={voice} />
        <JarvisCore activity={activity} voice={voice} />
      </group>
    </>
  );
}

export function JarvisWebGLOrb() {
  const streamState = useAppStore((s) => s.streamState);
  const speechEnabled = useAppStore((s) => s.settings.speechEnabled);
  const wakeWordEnabled = useAppStore((s) => s.settings.wakeWordEnabled);
  const activityRef = useRef(0.55);
  const voiceRef = useRef(0);

  useEffect(() => {
    activityRef.current = streamState.isStreaming ? 1.0 : speechEnabled && wakeWordEnabled ? 0.72 : 0.42;
  }, [streamState.isStreaming, speechEnabled, wakeWordEnabled]);

  useEffect(() => {
    const onSpeechState = (event: Event) => {
      const detail = (event as CustomEvent<{ state?: string }>).detail;
      if (detail?.state === 'recording') voiceRef.current = Math.max(voiceRef.current, 0.55);
      if (detail?.state === 'transcribing') voiceRef.current = Math.max(voiceRef.current, 0.25);
      if (detail?.state === 'idle') voiceRef.current = 0;
    };
    const onSpeechLevel = (event: Event) => {
      const detail = (event as CustomEvent<{ level?: number }>).detail;
      const level = Math.max(0, Math.min(1, (detail?.level || 0) * 8));
      voiceRef.current = Math.max(voiceRef.current * 0.72, level);
    };
    window.addEventListener('openjarvis-speech-state', onSpeechState);
    window.addEventListener('openjarvis-speech-level', onSpeechLevel);
    return () => {
      window.removeEventListener('openjarvis-speech-state', onSpeechState);
      window.removeEventListener('openjarvis-speech-level', onSpeechLevel);
    };
  }, []);

  useEffect(() => {
    let frame = 0;
    const softenVoice = () => {
      voiceRef.current *= 0.94;
      frame = requestAnimationFrame(softenVoice);
    };
    frame = requestAnimationFrame(softenVoice);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div className="jarvis-reactor jarvis-r3f-reactor">
      <Canvas
        className="jarvis-webgl-orb jarvis-r3f-orb"
        camera={{ position: [0, 0, 6.2], fov: 42, near: 0.1, far: 40 }}
        dpr={[1, 1.65]}
        gl={{ alpha: true, antialias: true, powerPreference: 'high-performance' }}
      >
        <JarvisThreeScene activity={activityRef} voice={voiceRef} />
      </Canvas>
      <div className="jarvis-reactor-ring jarvis-reactor-ring-a" />
      <div className="jarvis-reactor-ring jarvis-reactor-ring-b" />
      <div className="jarvis-reactor-ring jarvis-reactor-ring-c" />
      <div className="jarvis-reactor-ticks" />
      <div className="jarvis-reactor-crosshair" />
    </div>
  );
}
