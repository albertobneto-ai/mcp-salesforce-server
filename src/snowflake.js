
import snowflake from "snowflake-sdk";

let sfConn = null;
let sfConnecting = false;

function getSnowflakeConnection() {
  return new Promise((resolve, reject) => {
    if (sfConn && sfConn.isUp()) return resolve(sfConn);
    
    const account = process.env.SNOWFLAKE_ACCOUNT || "rajlbkg-yk87012";
    const username = process.env.SNOWFLAKE_USERNAME;
    const password = process.env.SNOWFLAKE_PASSWORD;
    const warehouse = process.env.SNOWFLAKE_WAREHOUSE || "COMPUTE_WH";
    const database = process.env.SNOWFLAKE_DATABASE || "ALGAR_CRM_LAKE";
    
    if (!username || !password) {
      return reject(new Error("SNOWFLAKE_USERNAME and SNOWFLAKE_PASSWORD env vars required"));
    }
    
    const connection = snowflake.createConnection({
      account, username, password, warehouse, database, schema: "PUBLIC"
    });
    
    connection.connect((err, conn) => {
      if (err) {
        console.error("[Snowflake] Connection error:", err.message);
        return reject(err);
      }
      console.log("[Snowflake] Connected:", conn.getId());
      sfConn = conn;
      resolve(conn);
    });
  });
}

function querySnowflake(sql) {
  return new Promise(async (resolve, reject) => {
    try {
      const conn = await getSnowflakeConnection();
      conn.execute({
        sqlText: sql,
        complete: (err, stmt, rows) => {
          if (err) return reject(err);
          resolve(rows || []);
        }
      });
    } catch (e) {
      reject(e);
    }
  });
}

export function registerSnowflakeRoutes(app) {
  
  // Test connection
  app.get("/api/snowflake/test", async (req, res) => {
    try {
      const rows = await querySnowflake("SELECT CURRENT_ACCOUNT() AS ACCOUNT, CURRENT_DATABASE() AS DB, CURRENT_WAREHOUSE() AS WH, CURRENT_USER() AS USR");
      res.json({ status: "ok", data: rows[0] });
    } catch (err) {
      res.json({ status: "error", message: err.message, account: process.env.SNOWFLAKE_ACCOUNT || "rajlbkg-yk87012", user: process.env.SNOWFLAKE_USERNAME });
    }
  });
  
  // Test with specific account format
  app.get("/api/snowflake/test-account/:account", async (req, res) => {
    try {
      const account = req.params.account;
      const username = process.env.SNOWFLAKE_USERNAME;
      const password = process.env.SNOWFLAKE_PASSWORD;
      const connection = snowflake.createConnection({
        account, username, password, 
        warehouse: "COMPUTE_WH", 
        database: "ALGAR_CRM_LAKE", 
        schema: "PUBLIC"
      });
      connection.connect((err, conn) => {
        if (err) return res.json({ status: "error", message: err.message, tried: account });
        conn.execute({
          sqlText: "SELECT CURRENT_ACCOUNT() AS A, CURRENT_USER() AS U",
          complete: (e, s, rows) => {
            if (e) return res.json({ status: "error", message: e.message });
            res.json({ status: "ok", tried: account, data: rows[0] });
          }
        });
      });
    } catch (err) {
      res.json({ status: "error", message: err.message });
    }
  });
  
  // List tables
  app.get("/api/snowflake/tables", async (req, res) => {
    try {
      const rows = await querySnowflake("SHOW TABLES IN SCHEMA ALGAR_CRM_LAKE.PUBLIC");
      const tables = rows.map(r => ({ name: r.name, rows: r.rows, created: r.created_on }));
      res.json({ status: "ok", tables });
    } catch (err) {
      res.json({ status: "error", message: err.message });
    }
  });
  
  // Query any table
  app.get("/api/snowflake/query/:table", async (req, res) => {
    try {
      const table = req.params.table.replace(/[^a-zA-Z0-9_]/g, "");
      const limit = parseInt(req.query.limit) || 100;
      const rows = await querySnowflake(`SELECT * FROM ${table} LIMIT ${limit}`);
      res.json({ status: "ok", table, count: rows.length, data: rows });
    } catch (err) {
      res.json({ status: "error", message: err.message });
    }
  });
  
  // Custom SQL query
  app.post("/api/snowflake/sql", async (req, res) => {
    try {
      const { sql } = req.body;
      if (!sql) return res.status(400).json({ status: "error", message: "sql required" });
      // Safety: only allow SELECT
      if (!sql.trim().toUpperCase().startsWith("SELECT")) {
        return res.status(400).json({ status: "error", message: "Only SELECT queries allowed via API" });
      }
      const rows = await querySnowflake(sql);
      res.json({ status: "ok", count: rows.length, data: rows });
    } catch (err) {
      res.json({ status: "error", message: err.message });
    }
  });
  
  // Overview: all tables with counts
  app.get("/api/snowflake/overview", async (req, res) => {
    try {
      const tables = ["ACCOUNTS", "CONTACTS", "CONTRACTS", "LEADS", "OPPORTUNITIES"];
      const results = {};
      for (const t of tables) {
        try {
          const rows = await querySnowflake(`SELECT * FROM ${t} LIMIT 200`);
          results[t.toLowerCase()] = rows;
        } catch (e) {
          results[t.toLowerCase()] = [];
        }
      }
      res.json({ status: "ok", data: results });
    } catch (err) {
      res.json({ status: "error", message: err.message });
    }
  });
  

  // Admin: execute any SQL (DDL/DML)
  app.post("/api/snowflake/execute", async (req, res) => {
    try {
      const { sql } = req.body;
      if (!sql) return res.status(400).json({ status: "error", message: "sql required" });
      const rows = await querySnowflake(sql);
      res.json({ status: "ok", count: Array.isArray(rows) ? rows.length : 0, data: rows });
    } catch (err) {
      res.json({ status: "error", message: err.message });
    }
  });

  console.log("Routes: snowflake/test, snowflake/tables, snowflake/query, snowflake/sql, snowflake/overview");
}
