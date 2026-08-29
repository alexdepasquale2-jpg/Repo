// Input handling and control systems

class InputManager {
    constructor() {
        this.keys = {};
        this.mouse = { x: 0, y: 0 };
        this.listeners = [];
        this.setupEventListeners();
    }

    setupEventListeners() {
        document.addEventListener('keydown', (e) => this.handleKeyDown(e));
        document.addEventListener('keyup', (e) => this.handleKeyUp(e));
        document.addEventListener('mousemove', (e) => this.handleMouseMove(e));
        document.addEventListener('click', (e) => this.handleClick(e));
    }

    handleKeyDown(e) {
        this.keys[e.key.toLowerCase()] = true;
        this.notifyListeners('keydown', e.key);
    }

    handleKeyUp(e) {
        this.keys[e.key.toLowerCase()] = false;
        this.notifyListeners('keyup', e.key);
    }

    handleMouseMove(e) {
        this.mouse.x = e.clientX;
        this.mouse.y = e.clientY;
    }

    handleClick(e) {
        this.notifyListeners('click', { x: e.clientX, y: e.clientY });
    }

    addListener(callback) {
        this.listeners.push(callback);
    }

    notifyListeners(type, data) {
        this.listeners.forEach(listener => listener(type, data));
    }

    isPressed(key) {
        return this.keys[key.toLowerCase()] || false;
    }
}
