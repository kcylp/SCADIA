const path = require('path');
const fs = require('fs');
const os = require('os');
const { fork } = require('child_process');

/**
 * SCADIA Headless Entry Point
 * 
 * This script is the entry point for standalone binaries.
 * It ensures the project data directory exists in the user's home folder
 * and then launches the SCADIA server.
 */

async function bootstrap() {
    console.log('SCADIA Headless starting...');

    // 1. Determine the user data directory (similar to Electron app)
    const homeDir = os.homedir();
    const scadiaDataDir = path.join(homeDir, 'scadia-headless-data');
    
    // 2. Ensure the directory exists (Electron-style)
    if (!fs.existsSync(scadiaDataDir)) {
        console.log(`Creating initial data directory: ${scadiaDataDir}`);
        try {
            fs.mkdirSync(scadiaDataDir, { recursive: true });
        } catch (err) {
            console.error(`Failed to create data directory: ${err.message}`);
            process.exit(1);
        }
    } else {
        console.log(`Using existing data directory: ${scadiaDataDir}`);
    }

    // 3. Resolve the server path
    const serverPath = path.join(__dirname, 'server', 'main.js');

    if (!fs.existsSync(serverPath)) {
        console.error(`Could not find SCADIA server at: ${serverPath}`);
        process.exit(1);
    }

    // 4. Launch the server (fork like Electron does)
    console.log(`Launching SCADIA server with userDir: ${scadiaDataDir}`);
    
    const serverProcess = fork(serverPath, [], {
        env: { ...process.env, userDir: scadiaDataDir },
        stdio: 'inherit'
    });

    serverProcess.on('error', (err) => {
        console.error(`Failed to start SCADIA server: ${err.message}`);
        process.exit(1);
    });

    // Keep the process running
    process.on('SIGINT', () => {
        console.log('Shutting down SCADIA server...');
        serverProcess.kill('SIGTERM');
        process.exit(0);
    });

    process.on('SIGTERM', () => {
        console.log('Shutting down SCADIA server...');
        serverProcess.kill('SIGTERM');
        process.exit(0);
    });
}

bootstrap();