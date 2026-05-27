// src/routes/download.js — Gera .docx
import express from 'express';
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();

router.post('/', authMiddleware, async (req, res) => {
  try {
    const { content, type, title } = req.body;
    if (!content) return res.status(400).json({ error: 'content obrigatorio' });

    const paragraphs = content.split('\n').map(line => {
      if (line.startsWith('## '))
        return new Paragraph({ heading: HeadingLevel.HEADING_1,
          children: [new TextRun({ text: line.replace('## ', ''), bold: true, font: 'Arial', size: 28 })] });
      if (line.startsWith('### '))
        return new Paragraph({ heading: HeadingLevel.HEADING_2,
          children: [new TextRun({ text: line.replace('### ', ''), bold: true, font: 'Arial', size: 24 })] });
      return new Paragraph({ children: [new TextRun({ text: line, font: 'Arial', size: 20 })], spacing: { after: 80 } });
    });

    const doc = new Document({ sections: [{ children: paragraphs }] });
    const buffer = await Packer.toBuffer(doc);
    const filename = title || `${type || 'documento'}_${Date.now()}`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.docx"`);
    res.send(buffer);
  } catch (err) {
    console.error('Download error:', err);
    res.status(500).json({ error: 'Erro ao gerar documento' });
  }
});

export default router;
