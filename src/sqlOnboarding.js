/**
 * SQL Server Onboarding Module
 * Maneja la configuración automática de credenciales SQL Server
 *
 * Flujo:
 * 1. Verificar credenciales guardadas
 * 2. Auto-detectar configuración de Soft Restaurant
 * 3. Probar conexión con credenciales descubiertas
 * 4. Si todo falla, pedir credenciales manualmente
 * 5. Guardar credenciales encriptadas para futuras conexiones
 */

const sql = require("mssql");
const Store = require("electron-store");
const softRestDiscovery = require("./softRestDiscovery");
const { getDynamicPort } = require("./softRestDiscovery");

// Encrypted store for SQL credentials
const credentialStore = new Store({
  name: "sql-credentials",
  encryptionKey: "xquisito-agent-secure-key-2024",
  schema: {
    host: { type: "string" },
    database: { type: "string" },
    user: { type: "string" },
    password: { type: "string" },
    isConfigured: { type: "boolean", default: false },
  },
});

// Usuario de la aplicación con permisos mínimos
const APP_USER = "xquisito_agent";

function generateSecurePassword() {
  // Generar contraseña segura para el usuario de la app
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%";
  let password = "";
  for (let i = 0; i < 16; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
}

/**
 * Obtiene las credenciales guardadas
 */
function getSavedCredentials() {
  if (!credentialStore.get("isConfigured")) {
    return null;
  }

  return {
    host: credentialStore.get("host"),
    database: credentialStore.get("database"),
    user: credentialStore.get("user"),
    password: credentialStore.get("password"),
  };
}

/**
 * Guarda las credenciales de forma encriptada
 */
function saveCredentials(credentials) {
  credentialStore.set("host", credentials.host);
  credentialStore.set("database", credentials.database);
  credentialStore.set("user", credentials.user);
  credentialStore.set("password", credentials.password);
  credentialStore.set("isConfigured", true);
}

/**
 * Limpia las credenciales guardadas
 */
function clearCredentials() {
  credentialStore.clear();
}

/**
 * Verifica si las credenciales ya están configuradas
 */
function isConfigured() {
  return credentialStore.get("isConfigured", false);
}

/**
 * Intenta conectar con credenciales SQL
 * Soporta instancias nombradas (servidor\instancia) y puertos dinámicos
 */
async function trySqlAuth(host, database, user, password) {
  console.log("[SQL] trySqlAuth - Intentando conexión...");
  console.log("[SQL] Host original:", host);
  console.log("[SQL] Database:", database);
  console.log("[SQL] User:", user);
  console.log("[SQL] Password:", password ? "***" : "(vacío)");

  // Parsear host para detectar instancia nombrada y/o puerto
  // Formatos soportados:
  // - localhost
  // - localhost\SQLEXPRESS
  // - localhost,1433
  // - localhost\SQLEXPRESS,1433
  let serverName = host;
  let instanceName = null;
  let port = null;

  // Primero verificar si hay puerto (separado por coma)
  if (host?.includes(",")) {
    const [serverPart, portPart] = host.split(",");
    serverName = serverPart;
    port = parseInt(portPart, 10);
    console.log("[SQL] Puerto explícito detectado:", port);
  }

  // Verificar si hay instancia nombrada (separado por backslash)
  if (serverName?.includes("\\")) {
    const parts = serverName.split("\\");
    serverName = parts[0];
    instanceName = parts[1];
    console.log("[SQL] Instancia nombrada detectada:", instanceName);

    // Solo buscar puerto dinámico en registro para servidores LOCALES
    const isLocalServer =
      ["localhost", "127.0.0.1", ".", "(local)"].includes(
        serverName.toLowerCase(),
      ) || serverName.toLowerCase() === require("os").hostname().toLowerCase();

    if (!port && isLocalServer) {
      console.log(
        "[SQL] Servidor local detectado, buscando puerto en registro...",
      );
      const dynamicPort = getDynamicPort(instanceName);
      if (dynamicPort) {
        port = dynamicPort;
        console.log("[SQL] Puerto dinámico encontrado en registro:", port);
      } else {
        console.log("[SQL] No se encontró puerto dinámico, usando SQL Browser");
      }
    } else if (!port) {
      console.log(
        "[SQL] Servidor remoto, usando SQL Browser para resolver puerto",
      );
    }
  }

  console.log("[SQL] Servidor final:", serverName);
  console.log("[SQL] Instancia:", instanceName || "(default)");
  console.log("[SQL] Puerto:", port || "(SQL Browser)");

  const config = {
    server: serverName,
    database: database,
    user: user,
    password: password,
    options: {
      trustServerCertificate: true,
      encrypt: false,
    },
    connectionTimeout: 30000,
  };

  // Si tenemos puerto, usarlo directamente (más confiable que SQL Browser)
  if (port) {
    config.port = port;
  } else if (instanceName) {
    // Solo usar instanceName si no tenemos puerto (depende de SQL Browser)
    config.options.instanceName = instanceName;
  }

  console.log(
    "[SQL] Config final (sin password):",
    JSON.stringify({ ...config, password: "***" }, null, 2),
  );
  console.log("CONFIG FINAL:", config);

  try {
    const pool = await sql.connect(config);
    console.log("[SQL] Conexión exitosa!");
    await pool.close();
    return { success: true };
  } catch (error) {
    console.error("[SQL] ERROR en trySqlAuth:");
    console.error("[SQL] Mensaje:", error.message);
    console.error("[SQL] Código:", error.code);
    console.error("[SQL] Stack:", error.stack);
    return { success: false, error: error.message, code: error.code };
  }
}

/**
 * Crea el usuario app_agent con permisos mínimos
 * @param {object} adminConfig - Configuración con credenciales de admin
 * @returns {object} - { success: boolean, user?: string, password?: string, error?: string }
 */
async function createAppUser(adminConfig) {
  console.log("[SQL] createAppUser - Creando usuario de aplicación...");
  console.log("[SQL] Host:", adminConfig.host);
  console.log("[SQL] Database:", adminConfig.database);
  console.log("[SQL] User:", adminConfig.user);

  // Parsear host para detectar instancia nombrada y/o puerto
  let serverName = adminConfig.host;
  let instanceName = null;
  let port = null;

  if (adminConfig.host?.includes(",")) {
    const [serverPart, portPart] = adminConfig.host.split(",");
    serverName = serverPart;
    port = parseInt(portPart, 10);
  }

  if (serverName?.includes("\\")) {
    const parts = serverName.split("\\");
    serverName = parts[0];
    instanceName = parts[1];

    // Solo buscar puerto dinámico en registro para servidores LOCALES
    const isLocalServer =
      ["localhost", "127.0.0.1", ".", "(local)"].includes(
        serverName.toLowerCase(),
      ) || serverName.toLowerCase() === require("os").hostname().toLowerCase();

    if (!port && isLocalServer) {
      const dynamicPort = getDynamicPort(instanceName);
      if (dynamicPort) {
        port = dynamicPort;
      }
    }
  }

  const config = {
    server: serverName,
    database: "master", // Conectar a master para crear login
    user: adminConfig.user,
    password: adminConfig.password,
    options: {
      trustServerCertificate: true,
      encrypt: false,
    },
    connectionTimeout: 30000,
  };

  // Si tenemos puerto, usarlo directamente
  if (port) {
    config.port = port;
  } else if (instanceName) {
    // Solo usar instanceName si no tenemos puerto
    config.options.instanceName = instanceName;
  }

  console.log(
    "[SQL] Config final (sin password):",
    JSON.stringify({ ...config, password: "***" }, null, 2),
  );

  let pool;
  try {
    console.log("[SQL] Conectando a master...");
    pool = await sql.connect(config);
    console.log("[SQL] Conectado a master exitosamente");

    // Generar nueva contraseña para el usuario
    const appPassword = generateSecurePassword();

    // 1. Verificar si el login ya existe
    const loginExists = await pool.request().query(`
      SELECT name FROM sys.server_principals WHERE name = '${APP_USER}'
    `);

    if (loginExists.recordset.length > 0) {
      // El usuario ya existe, actualizar contraseña
      await pool.request().query(`
        ALTER LOGIN [${APP_USER}] WITH PASSWORD = '${appPassword}'
      `);
      console.log("[ONBOARDING] Usuario existente, contraseña actualizada");
    } else {
      // Crear nuevo login
      await pool.request().query(`
        CREATE LOGIN [${APP_USER}] WITH PASSWORD = '${appPassword}', DEFAULT_DATABASE = [${adminConfig.database}]
      `);
      console.log("[ONBOARDING] Login creado");
    }

    // 2. Conectar a la base de datos de Soft Restaurant
    await pool.close();
    config.database = adminConfig.database;
    pool = await sql.connect(config);

    // 3. Verificar si el usuario ya existe en la BD
    const userExists = await pool.request().query(`
      SELECT name FROM sys.database_principals WHERE name = '${APP_USER}'
    `);

    if (userExists.recordset.length === 0) {
      // Crear usuario en la base de datos
      await pool.request().query(`
        CREATE USER [${APP_USER}] FOR LOGIN [${APP_USER}]
      `);
      console.log("[ONBOARDING] Usuario de BD creado");
    }

    // 4. Otorgar permisos mínimos necesarios
    // Permisos de lectura en tablas necesarias
    const tables = [
      "tempcheques",
      "tempcheqdet",
      "tempchequespagos",
      "turnos",
      "formasdepago",
      "productos",
      "areas",
    ];

    for (const table of tables) {
      try {
        await pool.request().query(`
          GRANT SELECT, INSERT, UPDATE ON [dbo].[${table}] TO [${APP_USER}]
        `);
      } catch (e) {
        // La tabla podría no existir en algunas versiones
        console.log(`[ONBOARDING] Permiso en ${table}: ${e.message}`);
      }
    }

    console.log("[ONBOARDING] Permisos otorgados");

    await pool.close();

    return {
      success: true,
      user: APP_USER,
      password: appPassword,
    };
  } catch (error) {
    console.error("[SQL] ERROR en createAppUser:");
    console.error("[SQL] Mensaje:", error.message);
    console.error("[SQL] Código:", error.code);
    console.error("[SQL] Stack:", error.stack);
    if (pool) {
      try {
        await pool.close();
      } catch (e) {}
    }
    return {
      success: false,
      error: error.message,
      code: error.code,
    };
  }
}

/**
 * Flujo completo de onboarding
 * @param {object} params - { host, database, port, adminUser?, adminPassword?, skipDiscovery? }
 * @returns {object} - Estado del onboarding
 */
async function runOnboarding(params = {}) {
  console.log("[ONBOARDING] Iniciando...");

  // Paso 1: Verificar si ya hay credenciales configuradas
  if (isConfigured()) {
    const saved = getSavedCredentials();
    console.log("[ONBOARDING] Credenciales existentes encontradas");
    console.log("[ONBOARDING] Host:", saved.host);
    console.log("[ONBOARDING] Database:", saved.database);
    console.log("[ONBOARDING] User:", saved.user);

    const testResult = await trySqlAuth(
      saved.host,
      saved.database,
      saved.user,
      saved.password,
    );

    if (testResult.success) {
      return {
        status: "configured",
        message: "Credenciales existentes válidas",
        credentials: saved,
      };
    } else {
      console.log(
        "[ONBOARDING] Credenciales guardadas inválidas, reiniciando...",
      );
      clearCredentials();
    }
  }

  // Paso 2: Auto-detectar configuración de Soft Restaurant
  if (!params.skipDiscovery) {
    console.log("[ONBOARDING] Buscando configuración de Soft Restaurant...");
    const discovery = softRestDiscovery.discoverSqlConfig();

    if (discovery.found && discovery.config) {
      const disc = discovery.config;
      console.log("[ONBOARDING] Configuración descubierta:");
      console.log("[ONBOARDING] Server:", disc.server);
      console.log("[ONBOARDING] Database:", disc.database);
      console.log("[ONBOARDING] User:", disc.user);

      // Verificar que tenemos usuario y contraseña
      if (!disc.user || !disc.password) {
        console.log(
          "[ONBOARDING] No hay credenciales SQL en la configuración descubierta",
        );
        params.discoveredConfig = disc;
        params.discoverySource = discovery.source;
      } else {
        // Probar conexión con credenciales descubiertas
        console.log("[ONBOARDING] Probando credenciales SQL descubiertas...");

        const testResult = await trySqlAuth(
          disc.server,
          disc.database,
          disc.user,
          disc.password,
        );

        if (testResult.success) {
          console.log(
            "[ONBOARDING] Conexión exitosa con credenciales descubiertas",
          );

          const credentials = {
            host: disc.server,
            database: disc.database,
            user: disc.user,
            password: disc.password,
          };

          saveCredentials(credentials);

          return {
            status: "configured",
            message: `Configuración detectada automáticamente desde ${discovery.source}`,
            credentials: credentials,
            autoDiscovered: true,
          };
        } else {
          console.error(
            "[ONBOARDING] Credenciales descubiertas no funcionaron:",
          );
          console.error("[ONBOARDING] Error:", testResult.error);
          console.error("[ONBOARDING] Código:", testResult.code);

          // Intentar crear usuario propio
          console.log(
            "[ONBOARDING] Intentando crear usuario con credenciales descubiertas...",
          );
          const createResult = await createAppUser({
            host: disc.server,
            database: disc.database,
            user: disc.user,
            password: disc.password,
          });

          if (createResult.success) {
            console.log(
              "[ONBOARDING] Usuario creado exitosamente:",
              createResult.user,
            );
            const credentials = {
              host: disc.server,
              database: disc.database,
              user: createResult.user,
              password: createResult.password,
            };

            saveCredentials(credentials);

            return {
              status: "configured",
              message: `Usuario ${createResult.user} creado usando credenciales de Soft Restaurant`,
              credentials: credentials,
              autoDiscovered: true,
            };
          } else {
            console.error("[ONBOARDING] Error al crear usuario:");
            console.error("[ONBOARDING] Error:", createResult.error);
            console.error("[ONBOARDING] Código:", createResult.code);
          }
        }

        // Guardar info del discovery para mostrar al usuario
        params.discoveredConfig = disc;
        params.discoverySource = discovery.source;
      }
    }
  }

  // Usar parámetros proporcionados o defaults
  const host = params.host || params.discoveredConfig?.server;
  const database = params.database || params.discoveredConfig?.database;

  console.log("[ONBOARDING] Host final:", host);
  console.log("[ONBOARDING] Database final:", database);

  // Paso 3: Si se proporcionaron credenciales, usarlas directamente
  if (params.adminUser && params.adminPassword && host && database) {
    console.log("[ONBOARDING] Usando credenciales proporcionadas...");

    const testResult = await trySqlAuth(
      host,
      database,
      params.adminUser,
      params.adminPassword,
    );

    if (testResult.success) {
      saveCredentials({
        host,
        database,
        user: params.adminUser,
        password: params.adminPassword,
      });

      return {
        status: "configured",
        message: "Credenciales configuradas exitosamente",
        credentials: {
          host,
          database,
          user: params.adminUser,
        },
      };
    } else {
      console.error("[ONBOARDING] Credenciales proporcionadas no funcionaron:");
      console.error("[ONBOARDING] Error:", testResult.error);
      console.error("[ONBOARDING] Código:", testResult.code);
      return {
        status: "error",
        message: "Credenciales inválidas",
        error: testResult.error,
        code: testResult.code,
        needsCredentials: true,
      };
    }
  }

  // Paso 4: Necesita credenciales manuales
  console.log("[ONBOARDING] Necesita credenciales manuales");
  return {
    status: "needs_credentials",
    message:
      "No se pudo conectar automáticamente. Se requieren credenciales SQL Server.",
    needsCredentials: true,
    discoveredConfig: params.discoveredConfig || null,
    discoverySource: params.discoverySource || null,
    hint: params.discoveredConfig
      ? `Se encontró configuración en ${params.discoverySource} pero no se pudo conectar. Ingrese credenciales manualmente.`
      : "Ingrese las credenciales de SQL Server (usuario y contraseña)",
  };
}

/**
 * Obtiene la configuración SQL para usar en conexiones
 * Soporta instancias nombradas (servidor\instancia) y puertos dinámicos
 * @returns {object|null} - Configuración SQL lista para usar
 */
function getSqlConfig() {
  const creds = getSavedCredentials();
  if (!creds) return null;

  // Parsear host para detectar instancia nombrada y/o puerto
  let serverName = creds.host;
  let instanceName = null;
  let port = null;

  // Primero verificar si hay puerto (separado por coma)
  if (creds.host?.includes(",")) {
    const [serverPart, portPart] = creds.host.split(",");
    serverName = serverPart;
    port = parseInt(portPart, 10);
  }

  // Verificar si hay instancia nombrada (separado por backslash)
  if (serverName?.includes("\\")) {
    const parts = serverName.split("\\");
    serverName = parts[0];
    instanceName = parts[1];

    // Solo buscar puerto dinámico en registro para servidores LOCALES
    const isLocalServer =
      ["localhost", "127.0.0.1", ".", "(local)"].includes(
        serverName.toLowerCase(),
      ) || serverName.toLowerCase() === require("os").hostname().toLowerCase();

    if (!port && isLocalServer) {
      const dynamicPort = getDynamicPort(instanceName);
      if (dynamicPort) {
        port = dynamicPort;
      }
    }
  }

  const config = {
    server: serverName,
    database: creds.database,
    user: creds.user,
    password: creds.password,
    options: {
      trustServerCertificate: true,
      encrypt: false,
    },
    connectionTimeout: 30000,
    requestTimeout: 30000,
    pool: {
      min: 1,
      max: 10,
      idleTimeoutMillis: 30000,
    },
  };

  // Si tenemos puerto, usarlo directamente
  if (port) {
    config.port = port;
  } else if (instanceName) {
    // Solo usar instanceName si no tenemos puerto
    config.options.instanceName = instanceName;
  }

  return config;
}

module.exports = {
  runOnboarding,
  getSavedCredentials,
  saveCredentials,
  clearCredentials,
  isConfigured,
  getSqlConfig,
  trySqlAuth,
  createAppUser,
  // Discovery functions
  discoverSqlConfig: softRestDiscovery.discoverSqlConfig,
  getDiagnostics: softRestDiscovery.getDiagnostics,
};
