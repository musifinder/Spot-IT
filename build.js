const { execSync } = require('child_process');
const path = require('path');

console.log('Installing dependencies...');
execSync('npm install', { stdio: 'inherit', cwd: path.join(__dirname) });
console.log('Build complete.');
