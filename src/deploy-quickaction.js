const JSZip = require("jszip");

module.exports = function(app, conn) {
  app.post("/api/deploy-quickaction", async (req, res) => {
    try {
      const zip = new JSZip();
      
      zip.file("quickActions/Account.Criar_Lead.quickAction", `<?xml version="1.0" encoding="UTF-8"?>
<QuickAction xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Criar Lead</label>
    <type>Create</type>
    <targetObject>Lead</targetObject>
    <targetParentField>Conta_Origem__c</targetParentField>
    <optionsCreateFeedItem>true</optionsCreateFeedItem>
    <description>Cria Lead vinculado a Conta existente</description>
    <successMessage>Lead criado com sucesso</successMessage>
    <quickActionLayout>
        <layoutSectionStyle>TwoColumnsLeftToRight</layoutSectionStyle>
        <quickActionLayoutColumns>
            <quickActionLayoutItems>
                <emptySpace>false</emptySpace>
                <field>LastName</field>
                <uiBehavior>Required</uiBehavior>
            </quickActionLayoutItems>
            <quickActionLayoutItems>
                <emptySpace>false</emptySpace>
                <field>Company</field>
                <uiBehavior>Required</uiBehavior>
            </quickActionLayoutItems>
            <quickActionLayoutItems>
                <emptySpace>false</emptySpace>
                <field>Phone</field>
                <uiBehavior>Edit</uiBehavior>
            </quickActionLayoutItems>
        </quickActionLayoutColumns>
        <quickActionLayoutColumns>
            <quickActionLayoutItems>
                <emptySpace>false</emptySpace>
                <field>Email</field>
                <uiBehavior>Edit</uiBehavior>
            </quickActionLayoutItems>
            <quickActionLayoutItems>
                <emptySpace>false</emptySpace>
                <field>LeadSource</field>
                <uiBehavior>Edit</uiBehavior>
            </quickActionLayoutItems>
            <quickActionLayoutItems>
                <emptySpace>false</emptySpace>
                <field>CNPJ__c</field>
                <uiBehavior>Edit</uiBehavior>
            </quickActionLayoutItems>
        </quickActionLayoutColumns>
    </quickActionLayout>
</QuickAction>`);

      zip.file("package.xml", `<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
    <types>
        <members>Account.Criar_Lead</members>
        <name>QuickAction</name>
    </types>
    <version>62.0</version>
</Package>`);

      const zipBuf = await zip.generateAsync({ type: "nodebuffer" });
      
      const result = await new Promise((resolve, reject) => {
        conn.metadata.deploy(zipBuf, { rollbackOnError: true, singlePackage: true })
          .complete(true, (err, r) => err ? reject(err) : resolve(r));
      });

      res.json(result);
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });
};