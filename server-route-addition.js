/*
  ADD-ON: Net Profit Margin route
  ---------------------------------
  Paste this into your existing server.js, alongside your other routes.

  Requires two new npm packages — run this once in your project folder
  (and commit the updated package.json / package-lock.json):

      npm install multer

  (child_process, path, and fs are built into Node — no install needed.)

  This does NOT touch your existing login/session/database code —
  it's a new, independent route that happens to live in the same file
  and the same Render service.
*/

const multer = require('multer');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Uploaded CSVs are written to a temp folder, read by Python, then deleted.
const upload = multer({ dest: '/tmp/csv-uploads/' });

// If you want this behind login like your other tools, add your existing
// auth-checking middleware here (e.g. requireLogin) as a second argument
// before upload.single('file') — ask if you're not sure how yours is named.
app.post('/api/calculate-margin', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded.' });
  }
  if (!req.file.originalname.toLowerCase().endsWith('.csv')) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'Please upload a .csv file.' });
  }

  const csvPath = req.file.path;
  const python = spawn('python3', [path.join(__dirname, 'calculate_margin.py'), csvPath]);

  let output = '';
  let errorOutput = '';

  python.stdout.on('data', (data) => { output += data.toString(); });
  python.stderr.on('data', (data) => { errorOutput += data.toString(); });

  python.on('close', (code) => {
    fs.unlink(csvPath, () => {}); // always clean up the temp file

    let parsed;
    try {
      parsed = JSON.parse(output.trim());
    } catch (e) {
      console.error('Python output was not valid JSON:', output, errorOutput);
      return res.status(500).json({ error: 'Calculation engine returned an unexpected response.' });
    }

    if (parsed.error) {
      return res.status(422).json(parsed);
    }
    return res.status(200).json(parsed);
  });

  python.on('error', (err) => {
    console.error('Failed to start python3 subprocess:', err);
    fs.unlink(csvPath, () => {});
    return res.status(500).json({ error: 'Calculation engine is unavailable.' });
  });
});
