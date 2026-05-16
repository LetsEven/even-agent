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

// Obtener último turno y validar que esté abierto
// Si el último turno está cerrado, lanza error para rechazar la orden
async function getActiveTurno() {
  await ensureSqlConnection();

  // Obtener el último turno (sin importar si está abierto o cerrado)
  const result = await sqlPool.request().query(`
    SELECT TOP 1 idturnointerno, idturno, apertura, cierre
    FROM turnos
    ORDER BY idturnointerno DESC
  `);

  if (!result.recordset || result.recordset.length === 0) {
    throw new Error(
      "No hay turnos en el sistema. Abra un turno en Soft Restaurant.",
    );
  }

  const ultimoTurno = result.recordset[0];

  // Validar que el último turno esté abierto (cierre IS NULL)
  if (ultimoTurno.cierre !== null) {
    throw new Error(
      `El último turno (${ultimoTurno.idturno}) está cerrado. Abra un nuevo turno en Soft Restaurant para recibir órdenes.`,
    );
  }

  console.log(
    `[TURNO] Turno activo: ${ultimoTurno.idturno} (interno: ${ultimoTurno.idturnointerno})`,
  );
  return ultimoTurno;
}

// Obtener o crear mesero EVEN
// Busca mesero con nombre EVEN, si no existe lo crea
async function getOrCreateMeseroEven() {
  await ensureSqlConnection();

  // Buscar mesero existente con nombre EVEN
  const existing = await sqlPool.request().query(`
    SELECT idmesero FROM meseros WHERE nombre = 'EVEN'
  `);

  if (existing.recordset.length > 0) {
    console.log(
      `[MESERO] Mesero EVEN encontrado: ${existing.recordset[0].idmesero}`,
    );
    return existing.recordset[0].idmesero;
  }

  // No existe, crear nuevo mesero
  // Obtener el siguiente idmesero disponible
  const maxId = await sqlPool.request().query(`
    SELECT MAX(CAST(idmesero AS INT)) as maxId FROM meseros WHERE ISNUMERIC(idmesero) = 1
  `);
  const nextId = (maxId.recordset[0].maxId || 0) + 1;
  const idmesero = nextId.toString().padStart(2, "0"); // Formato "06", "07", etc.

  await sqlPool
    .request()
    .input("idmesero", sql.VarChar, idmesero)
    .input("nombre", sql.VarChar, "EVEN").query(`
      INSERT INTO meseros (
        idmesero, nombre, contraseña, tipo, fotografia, visible,
        idempresa, tipoacceso, perfil,
        monitormeserocolorfondo, monitormeserocolorletra,
        accesoindicadormesas, turnoabierto, comision,
        WorkspaceId
      ) VALUES (
        @idmesero, @nombre, 1234, 1, NULL, 1,
        (SELECT TOP 1 idempresa FROM empresas), 0, NULL,
        NULL, NULL,
        0, 0, 0.00,
        NEWID()
      )
    `);

  console.log(`[MESERO] Mesero EVEN creado con id: ${idmesero}`);
  return idmesero;
}

// Obtener siguiente número de cheque y orden desde tabla folios (actualiza todos los contadores)
async function getNextFolios() {
  await ensureSqlConnection();

  // Incrementar y obtener todos los folios atómicamente
  const result = await sqlPool.request().query(`
    UPDATE folios
    SET ultimofolio = ultimofolio + 1,
        ultimaorden = ultimaorden + 1,
        ultimofolionotadeconsumo = ultimofolionotadeconsumo + 1,
        ultimofolioproduccion = ultimofolioproduccion + 1
    OUTPUT INSERTED.ultimofolio, INSERTED.ultimaorden, INSERTED.ultimofolionotadeconsumo, INSERTED.ultimofolioproduccion
  `);

  // Validar que hay resultados
  if (!result.recordset || result.recordset.length === 0) {
    throw new Error(
      "La tabla folios esta vacia. Inicialice los folios en Soft Restaurant.",
    );
  }

  const row = result.recordset[0];
  if (row.ultimofolio === null || row.ultimofolio === undefined) {
    throw new Error("ultimofolio es NULL en la tabla folios");
  }
  if (row.ultimaorden === null || row.ultimaorden === undefined) {
    throw new Error("ultimaorden es NULL en la tabla folios");
  }

  console.log(
    `[FOLIOS] folio: ${row.ultimofolio}, orden: ${row.ultimaorden}, notaconsumo: ${row.ultimofolionotadeconsumo}, produccion: ${row.ultimofolioproduccion}`,
  );

  return {
    numcheque: row.ultimofolio,
    orden: row.ultimaorden,
    folionotadeconsumo: row.ultimofolionotadeconsumo,
    folioproduccion: row.ultimofolioproduccion,
  };
}

module.exports = {
  sql,
  connectSqlServer,
  ensureSqlConnection,
  getPool,
  closeConnection,
  getActiveTurno,
  getOrCreateMeseroEven,
  getNextFolios,
};
