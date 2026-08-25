const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb);
scene.fog = new THREE.Fog(0x87ceeb, 500, 1000);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

// Lighting
const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
scene.add(ambientLight);

const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
directionalLight.position.set(100, 100, 50);
directionalLight.castShadow = true;
directionalLight.shadow.mapSize.width = 2048;
directionalLight.shadow.mapSize.height = 2048;
scene.add(directionalLight);

// Terrain
const geometry = new THREE.PlaneGeometry(200, 200, 64, 64);
const material = new THREE.MeshStandardMaterial({ color: 0x4a8c3f });

const positionAttribute = geometry.getAttribute('position');
for (let i = 0; i < positionAttribute.count; i++) {
    const x = positionAttribute.getX(i);
    const z = positionAttribute.getZ(i);
    const height = Math.sin(x * 0.02) * Math.cos(z * 0.02) * 20;
    positionAttribute.setZ(i, height);
}
positionAttribute.needsUpdate = true;
geometry.computeVertexNormals();

const terrain = new THREE.Mesh(geometry, material);
terrain.rotation.x = -Math.PI / 2;
terrain.receiveShadow = true;
scene.add(terrain);

// Player character
const playerGeometry = new THREE.CapsuleGeometry(0.5, 2, 4, 8);
const playerMaterial = new THREE.MeshStandardMaterial({ color: 0xff6b6b });
const player = new THREE.Mesh(playerGeometry, playerMaterial);
player.position.set(0, 25, 0);
player.castShadow = true;
player.receiveShadow = true;
scene.add(player);

// Input
const keys = {};
window.addEventListener('keydown', (e) => keys[e.key.toLowerCase()] = true);
window.addEventListener('keyup', (e) => keys[e.key.toLowerCase()] = false);

// Game state
const playerSpeed = 0.3;
const playerRotationSpeed = 0.1;

function updatePlayer() {
    if (keys['w'] || keys['arrowup']) player.position.z -= playerSpeed;
    if (keys['s'] || keys['arrowdown']) player.position.z += playerSpeed;
    if (keys['a'] || keys['arrowleft']) player.rotation.y += playerRotationSpeed;
    if (keys['d'] || keys['arrowright']) player.rotation.y -= playerRotationSpeed;
}

function updateCamera() {
    const distance = 15;
    const height = 8;
    const targetX = player.position.x + Math.sin(player.rotation.y) * distance;
    const targetZ = player.position.z + Math.cos(player.rotation.y) * distance;

    camera.position.x += (targetX - camera.position.x) * 0.1;
    camera.position.y = player.position.y + height;
    camera.position.z += (targetZ - camera.position.z) * 0.1;
    camera.lookAt(player.position.x, player.position.y, player.position.z);
}

function gameLoop() {
    updatePlayer();
    updateCamera();
    renderer.render(scene, camera);
    requestAnimationFrame(gameLoop);
}

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

gameLoop();
