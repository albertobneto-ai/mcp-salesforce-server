// src/routes/download.js — Gera .docx a partir do conteudo
const express = require('express');
const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// POST /api/download
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { content, type, title } = req.body;
    if (!content) return res.status(400).json({ error: 'content obrigatorio' });

    const filename = title || `${type || 'documento'}_${Date.now()}`;

    // Converter markdown simples em paragrafos docx
    const paragraphs = content.split('\n').map(line => {
      if (line.startsWith('## ')) {
        return new Paragraph({
          heading: HeadingLevel.HEADING_1,
          children: [new TextRun({ text: line.replace('## ', ''), bold: true, font: 'Arial', size: 28 })],
        });
      }
      if (line.startsWith('### ')) {
        return new Paragraph({
          heading: HeadingLevel.HEADING_2,
          children: [new TextRun({ text: line.replace('### ', ''), bold: true, font: 'Arial', size: 24 })],
        });
      }
      return new Paragraph({
        children: [new TextRun({ text: line, font: 'Arial', size: 20 })],
        spacing: { after: 80 },
      });
    });

    const doc = new Document({
      sections: [{
        properties: {
          page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } },
        },
        children: paragraphs,
      }],
    });

    const buffer = await Packer.toBuffer(doc);

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.docx"`);
    res.send(buffer);
  } catch (err) {
    console.error('Download error:', err);
    res.status(500).json({ error: 'Erro ao gerar documento' });
  }
});

module.exports = router;
