const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const publicDir = path.join(root, 'public');
fs.mkdirSync(publicDir, { recursive: true });
// Only browser assets belong in the public CDN; never copy data or secrets.
for (const file of ['styles.css', 'app.js', 'public-form.js', 'form-config.js', 'work-hours.js', 'solicitar.html']) {
  fs.copyFileSync(path.join(root, file), path.join(publicDir, file));
}
