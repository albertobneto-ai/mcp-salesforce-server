/**
 * Partner Community User Management
 * "MuleSoft para pobres" — endpoint que simula integração iPaaS
 * Cria Contact + habilita Partner User + seta senha
 */

export function registerPartnerUserRoutes(app, sfClient) {

  const PARTNER_PROFILE_ID = '00egK00000A8UrdQAF';  // Partner Community User
  const PARTNER_ACCOUNT_ID = '001gK0000152ZUyQAM';  // Algar Telecom Participações S.A.
  const PARTNER_ROLE_ID = '00EgK0000086b6jUAA';     // Partner Vendedor

  // ── LIST partner users ────────────────────────────────────
  app.get('/api/partner-users', async (req, res) => {
    try {
      await sfClient.ensureConnected();
      const result = await sfClient.conn.query(
        "SELECT Id, Name, Username, Email, IsActive, ContactId, Contact.Name, Contact.Account.Name, Contact.Phone, Contact.Title " +
        "FROM User WHERE Profile.Name = 'Partner Community User' ORDER BY Name"
      );
      res.json({ success: true, total: result.totalSize, users: result.records });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── CREATE partner user (full flow) ───────────────────────
  app.post('/api/partner-users/create', async (req, res) => {
    try {
      const { firstName, lastName, email, phone, title, cnpj, password } = req.body;

      if (!lastName || !email) {
        return res.status(400).json({ error: 'lastName e email são obrigatórios' });
      }

      await sfClient.ensureConnected();
      const conn = sfClient.conn;

      // 1. Verificar se Contact já existe pelo email
      const existing = await conn.query(
        `SELECT Id, Name FROM Contact WHERE Email = '${email}' LIMIT 1`
      );

      let contactId;

      if (existing.totalSize > 0) {
        contactId = existing.records[0].Id;
        // Atualizar dados
        await conn.sobject('Contact').update({
          Id: contactId,
          FirstName: firstName || undefined,
          LastName: lastName,
          Phone: phone || undefined,
          Title: title || undefined,
        });
        console.log('[Partner] Contact atualizado:', contactId);
      } else {
        // 2. Criar Contact
        const contactData = {
          AccountId: PARTNER_ACCOUNT_ID,
          FirstName: firstName || '',
          LastName: lastName,
          Email: email,
          Phone: phone || '',
          Title: title || '',
        };
        const contactResult = await conn.sobject('Contact').create(contactData);
        if (!contactResult.success) {
          return res.status(400).json({ error: 'Erro ao criar Contact', details: contactResult.errors });
        }
        contactId = contactResult.id;
        console.log('[Partner] Contact criado:', contactId);
      }

      // 3. Verificar se já tem User para este Contact
      const existingUser = await conn.query(
        `SELECT Id, Username, IsActive FROM User WHERE ContactId = '${contactId}' LIMIT 1`
      );

      let userId;
      let username;
      let action;

      if (existingUser.totalSize > 0) {
        userId = existingUser.records[0].Id;
        username = existingUser.records[0].Username;
        action = 'updated';
        console.log('[Partner] User já existe:', userId);
      } else {
        // 4. Criar User
        // Username deve ser único — usar email + sufixo
        username = email.includes('@') ? email : email + '@algarpartner.dev';

        const userData = {
          ContactId: contactId,
          FirstName: firstName || '',
          LastName: lastName,
          Email: email,
          Username: username,
          Alias: (firstName ? firstName.charAt(0) : '') + lastName.substring(0, Math.min(lastName.length, 7)),
          ProfileId: PARTNER_PROFILE_ID,
          UserRoleId: PARTNER_ROLE_ID,
          TimeZoneSidKey: 'America/Sao_Paulo',
          LocaleSidKey: 'pt_BR',
          EmailEncodingKey: 'UTF-8',
          LanguageLocaleKey: 'pt_BR',
          CommunityNickname: (firstName || '').toLowerCase() + lastName.toLowerCase() + Math.floor(Math.random() * 100),
          IsActive: true,
        };

        const userResult = await conn.sobject('User').create(userData);
        if (!userResult.success) {
          return res.status(400).json({ error: 'Erro ao criar User', details: userResult.errors });
        }
        userId = userResult.id;
        action = 'created';
        console.log('[Partner] User criado:', userId);
      }

      // 5. Setar senha
      const pwd = password || 'Algar@Partner2026!';
      try {
        await conn.request({
          method: 'POST',
          url: `/services/data/v62.0/sobjects/User/${userId}/password`,
          body: JSON.stringify({ NewPassword: pwd }),
          headers: { 'Content-Type': 'application/json' }
        });
        console.log('[Partner] Senha definida para:', userId);
      } catch (pwdErr) {
        // Fallback via Apex
        try {
          await conn.tooling.executeAnonymous(
            `System.setPassword('${userId}', '${pwd}');`
          );
        } catch (apexErr) {
          console.log('[Partner] Aviso: não foi possível setar senha automaticamente');
        }
      }

      res.json({
        success: true,
        action,
        user: {
          id: userId,
          contactId,
          username,
          email,
          name: `${firstName || ''} ${lastName}`.trim(),
          password: pwd,
          loginUrl: 'https://orgfarm-6450ce60e0-dev-ed.develop.my.site.com/algarpartners/login'
        }
      });

    } catch (err) {
      console.error('[Partner] Error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── TOGGLE active/inactive ────────────────────────────────
  app.post('/api/partner-users/toggle', async (req, res) => {
    try {
      const { userId, isActive } = req.body;
      if (!userId) return res.status(400).json({ error: 'userId obrigatório' });

      await sfClient.ensureConnected();
      await sfClient.conn.sobject('User').update({ Id: userId, IsActive: isActive !== false });
      res.json({ success: true, userId, isActive: isActive !== false });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  console.log('[Partner Users] Routes registered (list, create, toggle)');
}
