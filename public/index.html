const fs = require('fs');
const path = require('path');
const express = require('express');
const app = express();

app.use(express.json());
app.use(express.static('public'));

const CSV_FILE = path.join(__dirname, 'students.csv');

// Initialisation sécurisée du CSV avec BOM UTF-8 (compatibilité Excel)
if (!fs.existsSync(CSV_FILE)) {
  fs.writeFileSync(CSV_FILE, '\uFEFFDate;Heure;Eleve;Scenario;Note_Globale;Appreciation\n', 'utf8');
}

// Route POST : Sauvegarde d'une évaluation
app.post('/api/save-evaluation', (req, res) => {
  try {
    const { eleve, scenario, noteGlobale, detailCriteres } = req.body;
    
    const now = new Date();
    const dateStr = now.toLocaleDateString('fr-FR');
    const timeStr = now.toLocaleTimeString('fr-FR');

    // Nettoyage strict des entrées pour éviter de casser la structure du CSV
    const cleanEleve = (eleve || 'Élève Anonyme').replace(/[";\r\n]/g, ' ').trim();
    const cleanScenario = (scenario || 'E33').replace(/[";\r\n]/g, ' ').trim();
    const cleanNote = (noteGlobale || 'N/A').toString().replace(/[";\r\n]/g, '').trim();
    const cleanDetail = (detailCriteres || '').replace(/[";\r\n]/g, ' ').trim();

    const csvLine = `"${dateStr}";"${timeStr}";"${cleanEleve}";"${cleanScenario}";"${cleanNote}";"${cleanDetail}"\n`;

    // Écriture synchrone pour parer aux écritures simultanées
    fs.appendFileSync(CSV_FILE, csvLine, 'utf8');
    
    return res.json({ success: true });
  } catch (err) {
    console.error("Erreur écriture CSV :", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Route GET : Lecture des évaluations pour l'espace enseignant
app.get('/api/get-evaluations', (req, res) => {
  try {
    if (!fs.existsSync(CSV_FILE)) {
      return res.json([]);
    }

    const fileContent = fs.readFileSync(CSV_FILE, 'utf8');
    const lines = fileContent.trim().split('\n');
    
    if (lines.length <= 1) return res.json([]);

    const records = [];
    for (let i = lines.length - 1; i >= 1; i--) {
      const line = lines[i].trim();
      if (!line) continue;

      const matches = line.match(/(".*?"|[^";\s]+)(?=\s*;|\s*$)/g);
      
      if (matches && matches.length >= 6) {
        records.push({
          date: matches[0].replace(/"/g, ''),
          heure: matches[1].replace(/"/g, ''),
          eleve: matches[2].replace(/"/g, ''),
          scenario: matches[3].replace(/"/g, ''),
          note: matches[4].replace(/"/g, ''),
          detail: matches[5].replace(/"/g, '')
        });
      }
    }

    return res.json(records);
  } catch (err) {
    console.error("Erreur lecture CSV :", err);
    return res.status(500).json({ error: "Impossible de lire les données" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur démarré sur http://localhost:${PORT}`));
