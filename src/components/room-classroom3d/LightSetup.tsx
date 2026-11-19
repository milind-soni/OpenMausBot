import { Environment } from "@react-three/drei";

import type { ClassroomColors } from "./colors";

export function LightSetup({ width, depth }: {
  colors: ClassroomColors;
  width: number;
  depth: number;
}) {
  const shadowExtent = Math.max(width, depth) * 0.72;
  return (
    <>
      <ambientLight intensity={0.42} color="#fff9f0" />
      <hemisphereLight args={["#eef6ff", "#c4a882", 0.48]} />

      {/* Natural daylight entering from the left-wall windows */}
      <directionalLight
        castShadow
        position={[-width * 0.72, 7.2, 1.8]}
        intensity={1.65}
        color="#fff6e5"
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-near={1}
        shadow-camera-far={width * 2.2}
        shadow-camera-left={-shadowExtent}
        shadow-camera-right={shadowExtent}
        shadow-camera-top={shadowExtent}
        shadow-camera-bottom={-shadowExtent}
        shadow-bias={-0.0003}
        shadow-normalBias={0.02}
      />

      {/* Subtle overhead classroom fixture fill lights */}
      {[-1, 1].map((side) => (
        <spotLight
          key={side}
          position={[side * width * 0.24, 5.0, Math.max(0, depth * 0.08)]}
          angle={0.75}
          penumbra={0.9}
          intensity={18}
          distance={18}
          decay={2}
          color="#f8fbff"
        />
      ))}

      {/* Soft podium / blackboard fill */}
      <spotLight
        position={[0, 5.0, -3.6]}
        angle={0.62}
        penumbra={0.95}
        intensity={14}
        distance={14}
        decay={2}
        color="#fffaf0"
      />

      <Environment preset="apartment" background={false} environmentIntensity={0.28} />
    </>
  );
}
