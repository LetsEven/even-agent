/**
 * Database Module - SQL Server Connection
 * Maneja conexión y queries básicas a Soft Restaurant
 */

const sql = require("mssql");
const sqlOnboarding = require("./sqlOnboarding");

let sqlPool = null;
let sqlConfig = null;

// Conecta a SQL Server usando config de onboarding o config.json
async function connectSqlServer(config) {
  // Primero intentar usar credenciales del onboarding
  const onboardingConfig = sqlOnboarding.getSqlConfig();

  if (onboardingConfig) {
    sqlConfig = onboardingConfig;
    console.log("[SQL] Usando credenciales de onboarding");
  } else {
    // Fallback a config.json (compatibilidad)
    sqlConfig = {
      server: config.sqlServer.host || "localhost",
      database: config.sqlServer.database || "softrestaurant10",
      port: config.sqlServer.port || 1433,
      options: {
        trustServerCertificate: true,
        encrypt: true,
      },
      connectionTimeout: 30000,
      requestTimeout: 30000,
      pool: {
        min: 1,
        max: 10,
        idleTimeoutMillis: 30000,
      },
    };

    // Windows Auth o SQL Auth según config
    if (config.sqlServer.options?.trustedConnection) {
      sqlConfig.options.trustedConnection = true;
    } else {
      sqlConfig.user = config.sqlServer.user || "sa";
      sqlConfig.password = config.sqlServer.password || "";
    }
  }

  sqlPool = await sql.connect(sqlConfig);
  const authMethod = sqlConfig.options?.trustedConnection
    ? "Windows Auth"
    : "SQL Auth";
  console.log(`[SQL] Conectado a ${sqlConfig.server} (${authMethod})`);
  return sqlPool;
}

// Verificar y reconectar SQL si es necesario
async function ensureSqlConnection() {
  try {
    if (!sqlPool || !sqlPool.connected) {
      console.log("[SQL] Reconectando...");
      if (sqlPool) {
        try {
          await sqlPool.close();
        } catch (e) {}
      }
      sqlPool = await sql.connect(sqlConfig);
      console.log("[SQL] Reconectado");
    }
  } catch (error) {
    console.error("[SQL] Error reconectando:", error.message);
    throw error;
  }
}

// Obtener el pool de conexión actual
function getPool() {
  return sqlPool;
}

// Cerrar conexión SQL
async function closeConnection() {
  if (sqlPool) {
    await sqlPool.close();
    sqlPool = null;
  }
}

// Obtener turno activo (abierto)
async function getActiveTurno() {
  await ensureSqlConnection();
  const result = await sqlPool.request().query(`
    SELECT TOP 1 idturno, apertura FROM turnos WHERE cierre IS NULL ORDER BY idturno DESC
  `);
  return result.recordset[0] || null;
}

// Obtener siguiente número de cheque
async function getNextNumCheque() {
  await ensureSqlConnection();
  const result = await sqlPool.request().query(`
    SELECT ISNULL(MAX(numcheque), 0) + 1 AS nextNumCheque
    FROM tempcheques
  `);
  return result.recordset[0].nextNumCheque;
}

module.exports = {
  sql,
  connectSqlServer,
  ensureSqlConnection,
  getPool,
  closeConnection,
  getActiveTurno,
  getNextNumCheque,
};
