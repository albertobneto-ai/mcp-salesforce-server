import { csvToAssets, generateKML, generateKMLsByCity } from '../kml-generator.js';

export function registerKmlRoutes(app) {

  // POST /api/kml/generate — recebe CSV, retorna KMLs
  app.post('/api/kml/generate', (req, res) => {
    try {
      const { csv, maxPerFile } = req.body;
      if (!csv) return res.status(400).json({ error: 'csv is required' });

      const assets = csvToAssets(csv);
      if (assets.length === 0) return res.status(400).json({ error: 'No valid assets found in CSV' });

      const kmls = generateKMLsByCity(assets, maxPerFile || 1000);

      const summary = kmls.map(k => ({
        city: k.city,
        filename: k.filename,
        assets: k.assets,
        sizeKB: Math.round(Buffer.byteLength(k.kml, 'utf8') / 1024 * 10) / 10,
      }));

      res.json({
        status: 'ok',
        totalAssets: assets.length,
        files: summary,
        kmls: kmls.map(k => ({ filename: k.filename, kml: k.kml })),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/kml/upload-sf — recebe KML string + credenciais, sobe pro SF Files
  app.post('/api/kml/upload-sf', async (req, res) => {
    try {
      const { kml, filename, title, sfUsername, sfPassword, sfToken } = req.body;
      if (!kml || !filename) return res.status(400).json({ error: 'kml and filename required' });

      // Auth no Salesforce (org SalesMaps)
      const loginUrl = 'https://login.salesforce.com';
      const username = sfUsername || 'albertobneto_salesmaps@gmail.com';
      const password = sfPassword || 'Nicework@0001';
      const secToken = sfToken || '5fEaKhNkvxsZIpkFXo7Sbg3P0';

      const params = new URLSearchParams({
        grant_type: 'password',
        client_id: 'SalesforceDevelopmentExperience',
        client_secret: '1384510088588713504',
        username: username,
        password: password + secToken,
      });

      const authRes = await fetch(loginUrl + '/services/oauth2/token', {
        method: 'POST', body: params,
      });
      const authData = await authRes.json();
      if (!authData.access_token) return res.status(401).json({ error: 'SF auth failed', detail: authData });

      const sfHeaders = {
        'Authorization': 'Bearer ' + authData.access_token,
        'Content-Type': 'application/json',
      };

      // Verificar se arquivo já existe (mesmo título)
      const searchQ = encodeURIComponent("SELECT ContentDocumentId FROM ContentVersion WHERE Title='" + (title || filename.replace('.kml','')) + "' AND FileType='KML' LIMIT 1");
      const searchRes = await fetch(authData.instance_url + '/services/data/v62.0/query?q=' + searchQ, { headers: sfHeaders });
      const searchData = await searchRes.json();
      
      let contentDocumentId = null;
      if (searchData.records && searchData.records.length > 0) {
        contentDocumentId = searchData.records[0].ContentDocumentId;
      }

      // Upload como ContentVersion
      const b64 = Buffer.from(kml, 'utf8').toString('base64');
      const cvBody = {
        Title: title || filename.replace('.kml', ''),
        PathOnClient: filename,
        VersionData: b64,
        Description: 'KML gerado pelo Ever i9 Ferramentas',
      };
      if (contentDocumentId) cvBody.ContentDocumentId = contentDocumentId;

      const uploadRes = await fetch(authData.instance_url + '/services/data/v62.0/sobjects/ContentVersion', {
        method: 'POST', headers: sfHeaders, body: JSON.stringify(cvBody),
      });
      const uploadData = await uploadRes.json();

      if (uploadData.success) {
        // Adicionar à library SF Maps Files
        const libQ = encodeURIComponent("SELECT Id FROM ContentWorkspace WHERE Name='SF Maps Files' LIMIT 1");
        const libRes = await fetch(authData.instance_url + '/services/data/v62.0/query?q=' + libQ, { headers: sfHeaders });
        const libData = await libRes.json();

        if (libData.records && libData.records.length > 0 && !contentDocumentId) {
          const cvQ = encodeURIComponent("SELECT ContentDocumentId FROM ContentVersion WHERE Id='" + uploadData.id + "'");
          const cvRes = await fetch(authData.instance_url + '/services/data/v62.0/query?q=' + cvQ, { headers: sfHeaders });
          const cvData = await cvRes.json();
          const docId = cvData.records[0].ContentDocumentId;

          await fetch(authData.instance_url + '/services/data/v62.0/sobjects/ContentWorkspaceDoc', {
            method: 'POST', headers: sfHeaders,
            body: JSON.stringify({ ContentWorkspaceId: libData.records[0].Id, ContentDocumentId: docId }),
          });
        }

        res.json({
          status: 'ok',
          message: contentDocumentId ? 'Arquivo atualizado (nova versão)' : 'Arquivo criado',
          contentVersionId: uploadData.id,
          filename: filename,
        });
      } else {
        res.status(500).json({ error: 'Upload failed', detail: uploadData });
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  console.log('KML routes registered: POST /api/kml/generate, POST /api/kml/upload-sf');
}
