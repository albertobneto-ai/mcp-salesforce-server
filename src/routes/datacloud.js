const express = require('express');
const router = express.Router();

module.exports = (conn) => {
  // Generic SSOT proxy
  router.get('/ssot/*', async (req, res) => {
    try {
      const path = '/services/data/v62.0/ssot/' + req.params[0];
      console.log('[DC] GET', path);
      const result = await conn.request({ method: 'GET', url: path });
      res.json({ status: 'ok', data: result });
    } catch (err) {
      res.json({ status: 'error', message: err.message || String(err), code: err.errorCode });
    }
  });

  // List all Data Cloud config via SOQL
  router.get('/overview', async (req, res) => {
    try {
      const [streams, dlos, segments, ir, activations] = await Promise.all([
        conn.query("SELECT Id,Name,Description,DataStreamStatus,RefreshFrequency,RefreshMode,LastRefreshDate,TotalNumberOfRowsAdded FROM DataStream ORDER BY Name LIMIT 50"),
        conn.query("SELECT Id,Name,Description,DataLakeObjectStatus,Category,TotalRecords,Storage,TotalNumberOfFields FROM DataLakeObjectInstance ORDER BY Name LIMIT 50"),
        conn.query("SELECT Id,Name,Description,SegmentStatus,LastSegmentMemberCount,PublishScheduleInterval,IncludeCriteria,ExcludeCriteria FROM MarketSegment ORDER BY Name LIMIT 50"),
        conn.query("SELECT Id,Name,Status,LastRunStatus,SourceCount,MatchedCount,UnifiedCount,ConsolidationRate,IsScheduled FROM IdentityResolution LIMIT 20"),
        conn.query("SELECT Id,Name,MarketSegmentId,LastPublishStatus,ActivationRefreshType,RecordCount FROM MarketSegmentActivation LIMIT 50")
      ]);
      res.json({
        status: 'ok',
        data: {
          streams: streams.records || [],
          dlos: dlos.records || [],
          segments: segments.records || [],
          identityResolution: ir.records || [],
          activations: activations.records || []
        }
      });
    } catch (err) {
      res.json({ status: 'error', message: err.message });
    }
  });

  // Describe Data Cloud object
  router.get('/describe/:objectName', async (req, res) => {
    try {
      const meta = await conn.sobject(req.params.objectName).describe();
      const fields = meta.fields.map(f => ({
        name: f.name, type: f.type, label: f.label,
        updateable: f.updateable, createable: f.createable,
        picklistValues: f.picklistValues?.filter(p => p.active).map(p => p.value)
      }));
      res.json({ status: 'ok', fields });
    } catch (err) {
      res.json({ status: 'error', message: err.message });
    }
  });

  return router;
};
