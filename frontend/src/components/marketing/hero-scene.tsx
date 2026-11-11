"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A small low-poly neighbourhood on a floating island, rendered with three.js.
 *
 * - three.js is imported inside the effect, so it is its own chunk and never delays first paint.
 * - The island drifts slowly and tilts toward the pointer; the featured home has a bobbing pin.
 * - Rendering pauses while the canvas is off screen or the tab is hidden.
 * - prefers-reduced-motion: one still frame, no animation loop.
 * - No WebGL: the container stays empty and the floating cards still show.
 */
export function HeroScene({ className }: { className?: string }) {
  const host = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    const node = host.current;
    if (!node) return;
    let disposed = false;
    let cleanup = () => {};

    (async () => {
      const THREE = await import("three");
      if (disposed) return;

      let renderer: import("three").WebGLRenderer;
      try {
        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" });
      } catch {
        return; // no WebGL
      }
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.05;
      renderer.domElement.setAttribute("aria-hidden", "true");
      renderer.domElement.style.display = "block";
      node.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
      camera.position.set(12.5, 10.5, 14.5);
      camera.lookAt(0, 0.5, 0);

      // Light: soft sky fill plus a warm sun that casts the shadows.
      scene.add(new THREE.HemisphereLight(0xffffff, 0xd8cfbf, 1.1));
      const sun = new THREE.DirectionalLight(0xfff1dc, 2.4);
      sun.position.set(7, 12, 5);
      sun.castShadow = true;
      sun.shadow.mapSize.set(1024, 1024);
      sun.shadow.camera.left = -7;
      sun.shadow.camera.right = 7;
      sun.shadow.camera.top = 7;
      sun.shadow.camera.bottom = -7;
      sun.shadow.bias = -0.0005;
      sun.shadow.radius = 4;
      scene.add(sun);

      const geometries: import("three").BufferGeometry[] = [];
      const materials: import("three").Material[] = [];
      const mat = (color: number, extra: Partial<import("three").MeshStandardMaterialParameters> = {}) => {
        const m = new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0, flatShading: true, ...extra });
        materials.push(m);
        return m;
      };
      const geo = <T extends import("three").BufferGeometry>(g: T) => {
        geometries.push(g);
        return g;
      };
      const mesh = (g: import("three").BufferGeometry, m: import("three").Material, cast = true, receive = true) => {
        const object = new THREE.Mesh(g, m);
        object.castShadow = cast;
        object.receiveShadow = receive;
        return object;
      };

      const world = new THREE.Group();
      scene.add(world);

      // Floating island: grass top, earthy sides, a lighter street.
      const island = new THREE.Group();
      island.add(mesh(geo(new THREE.CylinderGeometry(5.2, 4.6, 0.7, 48)), mat(0xb9d39a), false, true));
      const base = mesh(geo(new THREE.CylinderGeometry(4.6, 3.2, 1.1, 48)), mat(0xc9a77c), false, false);
      base.position.y = -0.9;
      island.add(base);
      island.position.y = -0.35;
      world.add(island);

      const street = mesh(geo(new THREE.BoxGeometry(8.4, 0.04, 1.3)), mat(0xe8e2d6), false, true);
      street.position.set(0, 0.02, 2.3);
      world.add(street);
      const lane = mesh(geo(new THREE.BoxGeometry(0.9, 0.045, 1.4)), mat(0xe8e2d6), false, true);
      lane.position.set(0, 0.02, 1.2);
      world.add(lane);

      const windowMat = mat(0xcfe6ff, { emissive: 0x9cc8ff, emissiveIntensity: 0.25, roughness: 0.3 });
      const doorMat = mat(0x24324f);

      function house(w: number, d: number, h: number, wall: number, roof: number) {
        const g = new THREE.Group();
        const body = mesh(geo(new THREE.BoxGeometry(w, h, d)), mat(wall));
        body.position.y = h / 2;
        g.add(body);
        // Gable roof: a three-sided cylinder laid along the width, apex up, pitch flattened.
        const r = d * 0.66;
        const roofMesh = mesh(geo(new THREE.CylinderGeometry(r, r, w * 1.1, 3)), mat(roof));
        roofMesh.rotation.z = Math.PI / 2; // axis along X
        roofMesh.rotation.x = -Math.PI / 2; // one edge straight up
        const pitch = new THREE.Group();
        pitch.add(roofMesh);
        pitch.scale.y = 0.62;
        pitch.position.y = h + 0.5 * r * 0.62; // base of the triangle sits on the walls
        g.add(pitch);
        const door = mesh(geo(new THREE.BoxGeometry(w * 0.16, h * 0.45, 0.04)), doorMat, false, false);
        door.position.set(0, h * 0.225, d / 2 + 0.02);
        g.add(door);
        for (const x of [-w * 0.3, w * 0.3]) {
          const win = mesh(geo(new THREE.BoxGeometry(w * 0.18, h * 0.22, 0.04)), windowMat, false, false);
          win.position.set(x, h * 0.6, d / 2 + 0.02);
          g.add(win);
        }
        return g;
      }

      function tree(scale = 1) {
        const g = new THREE.Group();
        const trunk = mesh(geo(new THREE.CylinderGeometry(0.06, 0.08, 0.5, 6)), mat(0x8a6a4a));
        trunk.position.y = 0.25;
        g.add(trunk);
        const crown = mesh(geo(new THREE.IcosahedronGeometry(0.42, 0)), mat(0x6fa860));
        crown.position.y = 0.75;
        g.add(crown);
        g.scale.setScalar(scale);
        return g;
      }

      // The featured home, then its neighbours.
      const hero = house(2.2, 1.7, 1.25, 0xfbfaf7, 0x1f2a44);
      hero.position.set(0, 0, -0.2);
      world.add(hero);
      const chimney = mesh(geo(new THREE.BoxGeometry(0.22, 0.6, 0.22)), mat(0xb4573d));
      chimney.position.set(0.6, 1.95, -0.45);
      world.add(chimney);

      const neighbours: [number, number, number, number, number, number, number][] = [
        [-3.0, -0.4, 1.4, 1.2, 0.95, 0xf3ece2, 0xb4573d],
        [3.0, -0.5, 1.5, 1.2, 0.9, 0xe9eef5, 0x3d5a80],
        [-1.7, -3.3, 1.3, 1.1, 0.85, 0xf6f1e7, 0x4f6d5a],
        [1.9, -3.2, 1.4, 1.1, 0.9, 0xf1ebe4, 0xb4573d],
      ];
      for (const [x, z, w, d, h, wall, roof] of neighbours) {
        const n = house(w, d, h, wall, roof);
        n.position.set(x, 0, z);
        n.rotation.y = x < 0 ? 0.25 : -0.25;
        world.add(n);
      }
      const trees: [number, number, number][] = [
        [-1.7, 0.9, 0.9],
        [1.8, 0.8, 1],
        [-3.9, 1.9, 0.8],
        [3.8, 1.8, 0.85],
        [-2.2, 3.6, 0.75],
        [2.4, 3.5, 0.8],
        [0.1, -2.6, 1.1],
        [-3.9, -2.4, 0.8],
        [3.9, -2.5, 0.75],
        [0.9, 4.0, 0.65],
      ];
      for (const [x, z, s] of trees) {
        const t = tree(s);
        t.position.set(x, 0, z);
        t.rotation.y = x * 1.7;
        world.add(t);
      }

      // Location pin over the featured home, and a pulsing ring on the ground.
      const pin = new THREE.Group();
      const pinMat = mat(0x1f8a5b, { roughness: 0.4, emissive: 0x0f5a3a, emissiveIntensity: 0.25 });
      const head = mesh(geo(new THREE.SphereGeometry(0.34, 24, 16)), pinMat);
      head.position.y = 0.55;
      pin.add(head);
      const tip = mesh(geo(new THREE.ConeGeometry(0.3, 0.6, 24)), pinMat);
      tip.rotation.x = Math.PI;
      tip.position.y = 0.2;
      pin.add(tip);
      const dot = mesh(geo(new THREE.SphereGeometry(0.13, 16, 12)), mat(0xffffff, { flatShading: false }), false, false);
      dot.position.set(0, 0.58, 0.26);
      pin.add(dot);
      pin.position.set(0, 2.6, -0.2);
      world.add(pin);

      const ringMat = new THREE.MeshBasicMaterial({ color: 0x1f8a5b, transparent: true, opacity: 0.35, side: THREE.DoubleSide });
      materials.push(ringMat);
      const ring = new THREE.Mesh(geo(new THREE.RingGeometry(1.5, 1.62, 64)), ringMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(0, 0.05, -0.2);
      world.add(ring);

      // Sizing.
      const resize = () => {
        const { width, height } = node.getBoundingClientRect();
        if (!width || !height) return;
        renderer.setSize(width, height, false);
        renderer.domElement.style.width = `${width}px`;
        renderer.domElement.style.height = `${height}px`;
        camera.aspect = width / height;
        // Keep the whole island in view on narrow containers.
        camera.zoom = Math.min(1, (width / height) * 0.85);
        camera.updateProjectionMatrix();
      };
      resize();
      const sizeObserver = new ResizeObserver(resize);
      sizeObserver.observe(node);

      // Pointer tilt (eased), drift, bob and pulse.
      const target = { x: 0, y: 0 };
      const onPointer = (event: PointerEvent) => {
        const rect = node.getBoundingClientRect();
        target.x = ((event.clientX - rect.left) / rect.width - 0.5) * 2;
        target.y = ((event.clientY - rect.top) / rect.height - 0.5) * 2;
      };
      const onLeave = () => {
        target.x = 0;
        target.y = 0;
      };
      window.addEventListener("pointermove", onPointer, { passive: true });
      node.addEventListener("pointerleave", onLeave);

      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      let visible = true;
      let frame = 0;
      const clock = new THREE.Clock();
      const tilt = { x: 0, y: 0 };

      const render = () => {
        const t = clock.getElapsedTime();
        tilt.x += (target.x - tilt.x) * 0.05;
        tilt.y += (target.y - tilt.y) * 0.05;
        world.rotation.y = Math.sin(t * 0.18) * 0.22 + tilt.x * 0.25;
        world.rotation.x = tilt.y * 0.06;
        world.position.y = Math.sin(t * 0.9) * 0.06;
        pin.position.y = 2.6 + Math.sin(t * 2.2) * 0.12;
        pin.rotation.y = t * 0.8;
        const pulse = (t * 0.6) % 1;
        ring.scale.setScalar(0.8 + pulse * 0.6);
        ringMat.opacity = 0.45 * (1 - pulse);
        renderer.render(scene, camera);
      };
      const loop = () => {
        if (!visible || document.hidden) {
          frame = 0;
          return;
        }
        render();
        frame = requestAnimationFrame(loop);
      };
      const start = () => {
        if (!frame && !reduced) frame = requestAnimationFrame(loop);
      };

      if (reduced) render();
      else start();

      const viewObserver = new IntersectionObserver(([entry]) => {
        visible = entry.isIntersecting;
        if (visible) start();
      });
      viewObserver.observe(node);
      const onVisibility = () => {
        if (!document.hidden) start();
      };
      document.addEventListener("visibilitychange", onVisibility);
      node.dataset.ready = "true";

      cleanup = () => {
        cancelAnimationFrame(frame);
        sizeObserver.disconnect();
        viewObserver.disconnect();
        window.removeEventListener("pointermove", onPointer);
        node.removeEventListener("pointerleave", onLeave);
        document.removeEventListener("visibilitychange", onVisibility);
        geometries.forEach((g) => g.dispose());
        materials.forEach((m) => m.dispose());
        renderer.dispose();
        renderer.domElement.remove();
      };
    })();

    return () => {
      disposed = true;
      cleanup();
    };
  }, []);

  return <div ref={host} className={cn("relative", className)} data-testid="hero-scene" />;
}
