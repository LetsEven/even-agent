const fs = require("fs");
const path = require("path");
const os = require("os");

// Para leer el registro de Windows
let Registry;
try {
  Registry = require("winreg");
} catch (e) {
  // winreg no está instalado, usar alternativa
  Registry = null;
}

// Ubicaciones comunes donde Soft Restaurant guarda su configuración
const SEARCH_PATHS = [
  // National Soft (ubicación más común encontrada)
  "C:\\nationalsoft",
  "C:\\NationalSoft",
  "D:\\nationalsoft",
  "D:\\NationalSoft",
  // SR10
  "C:\\SR10",
  "C:\\SR",
  "C:\\Program Files\\SR10",
  "C:\\Program Files (x86)\\SR10",
  // SR11
  "C:\\SR11",
  "C:\\Program Files\\SR11",
  "C:\\Program Files (x86)\\SR11",
  "C:\\Program Files\\Soft Restaurant 11",
  "C:\\Program Files (x86)\\Soft Restaurant 11",
  // Genéricos
  "C:\\SoftRestaurant",
  "C:\\Soft Restaurant",
  "C:\\Program Files\\Soft Restaurant",
  "C:\\Program Files (x86)\\Soft Restaurant",
  "C:\\Program Files\\National Soft",
  "C:\\Program Files (x86)\\National Soft",
  // Unidad D
  "D:\\SR10",
  "D:\\SR11",
  "D:\\SoftRestaurant",
  // AppData paths
  path.join(os.homedir(), "AppData", "Local", "National_Soft"),
  path.join(os.homedir(), "AppData", "Local", "Soft Restaurant"),
  path.join(os.homedir(), "AppData", "Roaming", "National Soft"),
  path.join(os.homedir(), "AppData", "Roaming", "Soft Restaurant"),
];

// Rutas del registro de Windows donde National Soft guarda configuración
const REGISTRY_PATHS = [
  "SOFTWARE\\National Soft\\Soft Restaurant",
  "SOFTWARE\\National Soft\\Soft Restaurant 11",
  "SOFTWARE\\National Soft\\SR11",
  "SOFTWARE\\WOW6432Node\\National Soft\\Soft Restaurant",
  "SOFTWARE\\WOW6432Node\\National Soft\\Soft Restaurant 11",
];

// Instancias SQL conocidas de Soft Restaurant
const KNOWN_SQL_INSTANCES = [
  "NATIONALSOFT",
  "SQLEXPRESS",
  "MSSQLSERVER",
  "SR_SQLEXPRESS",
];

// Archivos de configuración conocidos (orden de prioridad)
const CONFIG_FILES = [
  // National Soft - Archivos de empresa (más importantes)
  "Empresa 1.ini",
  "Empresa 2.ini",
  "Empresa 3.ini",
  "restaurant.ini",
  // Archivos genéricos
  "conexion.ini",
  "config.ini",
  "database.ini",
  // .NET config
  "SoftRestaurant.exe.config",
  "SR.exe.config",
  "app.config",
  "web.config",
  "SRConfig.xml",
  "conexion.txt",
];

// Patrones de nombres de base de datos de Soft Restaurant
const DATABASE_NAME_PATTERNS = [
  // Con 'e' (softrestaurante)
  /^softrestaurante?\d*$/i,
  // Abreviaciones
  /^sr\d+$/i,
  /^softrest\d*$/i,
  // Específicos
  /^soft_?restaurant_?\d*$/i,
];

// Lista de nombres comunes para probar si no se encuentra config
const COMMON_DATABASE_NAMES = [
  "softrestaurant10",
  "softrestaurant11",
  "softrestaurant12",
  "softrestaurante10",
  "softrestaurante11",
  "softrestaurante12",
  "softrestaurant",
  "softrestaurante",
  "sr10",
  "sr11",
  "sr12",
  "SoftRest10",
  "SoftRest11",
];

// Detecta interfaces VPN y retorna su IP
function getVpnIp() {
  const networkInterfaces = os.networkInterfaces();
  let vpnIp = null;
  let hamachiIp = null;

  for (const [name, interfaces] of Object.entries(networkInterfaces)) {
    const lowerName = name.toLowerCase();

    for (const iface of interfaces) {
      // Solo IPv4 y no internas
      if (iface.family !== "IPv4" || iface.internal) continue;

      const ip = iface.address;

      // Hamachi usa rango 25.x.x.x o 26.x.x.x (prioridad alta)
      if (ip.startsWith("25.") || ip.startsWith("26.")) {
        hamachiIp = ip;
        console.log("[DISCOVERY] IP Hamachi detectada:", ip);
      }

      // Detectar por nombre de interfaz
      if (
        lowerName.includes("hamachi") ||
        lowerName.includes("zerotier") ||
        lowerName.includes("vpn") ||
        lowerName.includes("tap") ||
        lowerName.includes("tun")
      ) {
        vpnIp = ip;
        console.log("[DISCOVERY] IP VPN detectada (" + name + "):", ip);
      }
    }
  }

  // Priorizar Hamachi sobre otros VPNs
  return hamachiIp || vpnIp;
}

// Verifica si un servidor es local (esta máquina)
function isLocalServer(server) {
  if (!server) return false;
  const lower = server.toLowerCase();
  const hostname = os.hostname().toLowerCase();

  return (
    lower === "localhost" ||
    lower === "127.0.0.1" ||
    lower === "." ||
    lower === "(local)" ||
    lower === hostname
  );
}

// Verifica si existe una regla de firewall para el puerto
function firewallRuleExists(port) {
  if (process.platform !== "win32") return true;

  const { execSync } = require("child_process");

  try {
    const psCommand = `Get-NetFirewallRule -DisplayName "SQL Server Port ${port}" -ErrorAction SilentlyContinue`;
    const result = execSync(`powershell -Command "${psCommand}"`, {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    return result.trim().length > 0;
  } catch (e) {
    return false;
  }
}

// Crea regla de firewall para permitir conexiones al puerto SQL
function createFirewallRule(port, instanceName = "SQL") {
  if (process.platform !== "win32") {
    return { success: false, error: "Solo disponible en Windows" };
  }

  const { execSync } = require("child_process");
  const ruleName = `SQL Server Port ${port}`;

  // Verificar si ya existe
  if (firewallRuleExists(port)) {
    console.log("[FIREWALL] Regla ya existe para puerto:", port);
    return { success: true, alreadyExists: true };
  }

  try {
    console.log("[FIREWALL] Creando regla para puerto:", port);

    const psCommand = `New-NetFirewallRule -DisplayName "${ruleName}" -Direction Inbound -Protocol TCP -LocalPort ${port} -Action Allow -Description "Permite conexiones a SQL Server ${instanceName}"`;

    execSync(`powershell -Command "${psCommand}"`, {
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
    });

    console.log("[FIREWALL] Regla creada exitosamente");
    return { success: true };
  } catch (e) {
    const errorMsg = e.message || "";

    // Detectar si es error de permisos
    if (
      errorMsg.includes("Access") ||
      errorMsg.includes("denied") ||
      errorMsg.includes("administrator")
    ) {
      console.log("[FIREWALL] Se requieren permisos de administrador");
      return {
        success: false,
        requiresAdmin: true,
        error: "Se requieren permisos de administrador",
      };
    }

    console.log("[FIREWALL] Error creando regla:", errorMsg.substring(0, 100));
    return { success: false, error: errorMsg };
  }
}

/**
 * Intenta crear regla de firewall con elevación (UAC)
 * @param {number} port - Puerto a permitir
 * @param {string} instanceName - Nombre de la instancia
 * @returns {{success: boolean, error?: string}}
 */
function createFirewallRuleElevated(port, instanceName = "SQL") {
  if (process.platform !== "win32") {
    return { success: false, error: "Solo disponible en Windows" };
  }

  if (firewallRuleExists(port)) {
    return { success: true, alreadyExists: true };
  }

  const { execSync } = require("child_process");
  const ruleName = `SQL Server Port ${port}`;

  try {
    console.log("[FIREWALL] Solicitando permisos de administrador...");

    // Usar Start-Process con -Verb RunAs para elevar permisos
    const innerCommand = `New-NetFirewallRule -DisplayName '${ruleName}' -Direction Inbound -Protocol TCP -LocalPort ${port} -Action Allow -Description 'SQL Server ${instanceName}'`;
    const psCommand = `Start-Process powershell -ArgumentList '-Command', '${innerCommand}' -Verb RunAs -Wait`;

    execSync(`powershell -Command "${psCommand}"`, {
      encoding: "utf8",
      timeout: 30000,
      windowsHide: false, // Mostrar UAC
    });

    // Verificar si se creó
    if (firewallRuleExists(port)) {
      console.log("[FIREWALL] Regla creada exitosamente con elevación");
      return { success: true };
    } else {
      return { success: false, error: "El usuario canceló la elevación" };
    }
  } catch (e) {
    console.log(
      "[FIREWALL] Error con elevación:",
      e.message?.substring(0, 100),
    );
    return { success: false, error: e.message };
  }
}

/**
 * Lee configuración del registro de Windows usando PowerShell
 * @returns {object|null} - Configuración encontrada o null
 */
function readFromRegistry() {
  if (process.platform !== "win32") {
    return null;
  }

  const { execSync } = require("child_process");

  for (const regPath of REGISTRY_PATHS) {
    try {
      // Usar PowerShell para leer el registro
      const psCommand = `Get-ItemProperty -Path "HKLM:\\${regPath}" -ErrorAction SilentlyContinue | ConvertTo-Json`;
      const result = execSync(`powershell -Command "${psCommand}"`, {
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
      });

      if (result && result.trim()) {
        const data = JSON.parse(result);
        console.log(`[DISCOVERY] Registro encontrado: HKLM\\${regPath}`);

        // Buscar valores de conexión
        const config = {};
        for (const [key, value] of Object.entries(data)) {
          const lowerKey = key.toLowerCase();
          if (lowerKey.includes("server") || lowerKey.includes("datasource")) {
            config.server = value;
          } else if (
            lowerKey.includes("database") ||
            lowerKey.includes("catalog")
          ) {
            config.database = value;
          } else if (lowerKey.includes("user") && !lowerKey.includes("pass")) {
            config.user = value;
          } else if (
            lowerKey.includes("password") ||
            lowerKey.includes("pwd")
          ) {
            config.password = value;
          }
        }

        if (config.server || config.database) {
          return config;
        }
      }
    } catch (e) {
      // Ignorar errores, continuar con siguiente path
    }
  }

  return null;
}

/**
 * Obtiene el puerto dinámico de una instancia SQL desde el registro
 * @param {string} instanceName - Nombre de la instancia (ej: NATIONALSOFT)
 * @returns {number|null} - Puerto o null si no se encuentra
 */
function getDynamicPort(instanceName = "NATIONALSOFT") {
  if (process.platform !== "win32") return null;

  const { execSync } = require("child_process");

  console.log("[DISCOVERY] Buscando puerto para instancia:", instanceName);

  // Probar MSSQL17 primero ya que es la versión del usuario
  const versions = ["17", "16", "15", "14", "13", "12", "11", "10"];

  for (const ver of versions) {
    try {
      // Usar comillas simples dentro del comando PowerShell
      const regPath = `HKLM:\\SOFTWARE\\Microsoft\\Microsoft SQL Server\\MSSQL${ver}.${instanceName}\\MSSQLServer\\SuperSocketNetLib\\Tcp\\IPAll`;
      const psCommand = `(Get-ItemProperty -Path '${regPath}' -ErrorAction Stop).TcpDynamicPorts`;

      console.log("[DISCOVERY] Probando MSSQL" + ver + "...");

      const result = execSync(`powershell -Command "${psCommand}"`, {
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
      });

      const trimmed = result.trim();
      console.log("[DISCOVERY] MSSQL" + ver + " resultado: '" + trimmed + "'");

      const port = parseInt(trimmed);
      if (port && port > 0) {
        console.log("[DISCOVERY] Puerto encontrado:", port);
        return port;
      }
    } catch (e) {
      // Solo mostrar error para MSSQL17 que es el que debería funcionar
      if (ver === "17") {
        console.log("[DISCOVERY] MSSQL17 falló:", e.message.split("\n")[0]);
      }
    }
  }

  console.log("[DISCOVERY] No se encontró puerto para:", instanceName);
  return null;
}

/**
 * Intenta detectar instancias SQL de National Soft
 * @returns {string[]} - Lista de servidores a probar
 */
function getKnownServers() {
  const servers = ["localhost"];

  // Agregar instancias conocidas
  for (const instance of KNOWN_SQL_INSTANCES) {
    servers.push(`localhost\\${instance}`);
    servers.push(`.\\${instance}`);
  }

  // Intentar obtener el nombre del equipo
  try {
    const hostname = os.hostname();
    for (const instance of KNOWN_SQL_INSTANCES) {
      servers.push(`${hostname}\\${instance}`);
    }
  } catch (e) {
    // Ignorar
  }

  return servers;
}

/**
 * Verifica si un nombre de base de datos parece ser de Soft Restaurant
 * @param {string} dbName - Nombre de la base de datos
 * @returns {boolean}
 */
function isSoftRestaurantDatabase(dbName) {
  if (!dbName) return false;
  const lower = dbName.toLowerCase();
  return DATABASE_NAME_PATTERNS.some((pattern) => pattern.test(lower));
}

/**
 * Normaliza el nombre de la base de datos
 * Si no se proporciona uno válido, devuelve el primer nombre común
 * @param {string|null} dbName - Nombre de la base de datos encontrado
 * @returns {string} - Nombre normalizado
 */
function normalizeDatabaseName(dbName) {
  if (dbName && isSoftRestaurantDatabase(dbName)) {
    return dbName;
  }
  // Si el nombre no es reconocido, usar el default más común
  return COMMON_DATABASE_NAMES[0]; // 'softrestaurant10'
}

/**
 * Busca directorios de Soft Restaurant en el sistema
 * @returns {string[]} - Lista de directorios encontrados
 */
function findSoftRestaurantDirs() {
  const found = [];

  for (const basePath of SEARCH_PATHS) {
    if (fs.existsSync(basePath)) {
      found.push(basePath);
      console.log(`[DISCOVERY] Directorio encontrado: ${basePath}`);
    }
  }

  // Buscar en unidades disponibles
  const drives = ["C", "D", "E", "F"];
  for (const drive of drives) {
    const drivePath = `${drive}:\\`;
    if (fs.existsSync(drivePath)) {
      try {
        const dirs = fs.readdirSync(drivePath);
        for (const dir of dirs) {
          const lowerDir = dir.toLowerCase();
          if (
            lowerDir.includes("sr10") ||
            lowerDir.includes("sr11") ||
            lowerDir.includes("softrest") ||
            lowerDir.includes("soft restaurant") ||
            lowerDir.includes("nationalsoft") ||
            lowerDir === "national soft"
          ) {
            const fullPath = path.join(drivePath, dir);
            if (
              fs.statSync(fullPath).isDirectory() &&
              !found.includes(fullPath)
            ) {
              found.push(fullPath);
              console.log(`[DISCOVERY] Directorio encontrado: ${fullPath}`);
            }
          }
        }
      } catch (e) {
        // Ignorar errores de acceso
      }
    }
  }

  return found;
}

/**
 * Busca archivos de configuración en un directorio
 * Prioriza archivos en carpetas INIS (National Soft)
 * @param {string} dir - Directorio a buscar
 * @returns {string[]} - Lista de archivos de configuración encontrados (ordenados por prioridad)
 */
function findConfigFiles(dir) {
  const priorityFiles = []; // Archivos en carpetas INIS (alta prioridad)
  const normalFiles = []; // Otros archivos de config

  function searchDir(currentDir, depth = 0) {
    if (depth > 4) return; // Buscar un poco más profundo para encontrar INIS

    try {
      const items = fs.readdirSync(currentDir);
      const isInisFolder = currentDir.toLowerCase().includes("inis");

      for (const item of items) {
        const fullPath = path.join(currentDir, item);
        try {
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            // Priorizar carpetas INIS y SoftRestaurant*
            const lowerDir = item.toLowerCase();
            if (lowerDir === "inis" || lowerDir.includes("softrestaurant")) {
              searchDir(fullPath, depth + 1);
            } else if (depth < 3) {
              searchDir(fullPath, depth + 1);
            }
          } else if (stat.isFile()) {
            const lowerItem = item.toLowerCase();
            // Buscar archivos de configuración conocidos
            const isKnownConfig = CONFIG_FILES.some(
              (cf) => lowerItem === cf.toLowerCase(),
            );
            const isIniFile = lowerItem.endsWith(".ini");
            const isConfigFile = lowerItem.endsWith(".config");
            const isConexionTxt =
              lowerItem.includes("conexion") && lowerItem.endsWith(".txt");

            if (isKnownConfig || isIniFile || isConfigFile || isConexionTxt) {
              // Priorizar archivos "Empresa X.ini" en carpetas INIS
              if (isInisFolder && lowerItem.startsWith("empresa")) {
                priorityFiles.push(fullPath);
                console.log(
                  `[DISCOVERY] [PRIORIDAD] Archivo de config: ${fullPath}`,
                );
              } else {
                normalFiles.push(fullPath);
                console.log(
                  `[DISCOVERY] Archivo de config encontrado: ${fullPath}`,
                );
              }
            }
          }
        } catch (e) {
          // Ignorar errores de acceso a archivos individuales
        }
      }
    } catch (e) {
      // Ignorar errores de acceso al directorio
    }
  }

  searchDir(dir);

  // Ordenar por versión: SR12 > SR11 > SR10 (más reciente primero)
  const sortByVersion = (files) => {
    return files.sort((a, b) => {
      const versionA = a.match(/softrestaurant(\d+)/i)?.[1] || "0";
      const versionB = b.match(/softrestaurant(\d+)/i)?.[1] || "0";
      return parseInt(versionB) - parseInt(versionA); // Mayor versión primero
    });
  };

  // Devolver archivos prioritarios primero, ordenados por versión
  return [...sortByVersion(priorityFiles), ...sortByVersion(normalFiles)];
}

/**
 * Parsea un archivo .config de .NET para extraer connection strings
 * @param {string} filePath - Ruta al archivo .config
 * @returns {object|null} - Configuración de conexión o null
 */
function parseNetConfig(filePath) {
  try {
    const content = fs.readFileSync(filePath, "utf8");

    // Buscar connectionStrings en formato XML
    // <add name="..." connectionString="Data Source=...;Initial Catalog=...;User Id=...;Password=..." />
    const connectionStringRegex = /connectionString\s*=\s*"([^"]+)"/gi;
    const matches = content.matchAll(connectionStringRegex);

    for (const match of matches) {
      const connStr = match[1];
      const parsed = parseConnectionString(connStr);
      if (
        parsed &&
        parsed.database &&
        (parsed.database.toLowerCase().includes("soft") ||
          parsed.database.toLowerCase().includes("sr"))
      ) {
        console.log(`[DISCOVERY] Connection string encontrada en: ${filePath}`);
        return parsed;
      }
    }

    // También buscar en appSettings
    // <add key="Server" value="localhost" />
    const serverMatch = content.match(
      /<add\s+key\s*=\s*"(Server|DataSource|Host)"\s+value\s*=\s*"([^"]+)"/i,
    );
    const dbMatch = content.match(
      /<add\s+key\s*=\s*"(Database|InitialCatalog|Catalog)"\s+value\s*=\s*"([^"]+)"/i,
    );
    const userMatch = content.match(
      /<add\s+key\s*=\s*"(User|UserId|Username)"\s+value\s*=\s*"([^"]+)"/i,
    );
    const passMatch = content.match(
      /<add\s+key\s*=\s*"(Password|Pwd)"\s+value\s*=\s*"([^"]+)"/i,
    );

    if (serverMatch && dbMatch) {
      return {
        server: serverMatch[2],
        database: dbMatch[2],
        user: userMatch ? userMatch[2] : null,
        password: passMatch ? passMatch[2] : null,
        integratedSecurity: !userMatch,
      };
    }
  } catch (e) {
    console.log(`[DISCOVERY] Error parseando ${filePath}: ${e.message}`);
  }

  return null;
}

/**
 * Decodifica una contraseña Base64 si está codificada
 * @param {string} pwd - Contraseña (posiblemente en Base64)
 * @returns {string} - Contraseña decodificada
 */
function decodePassword(pwd) {
  if (!pwd) return "";

  // Verificar si parece Base64 (solo caracteres alfanuméricos, +, /, =)
  // y tiene una longitud razonable para Base64
  if (/^[A-Za-z0-9+/]+=*$/.test(pwd) && pwd.length >= 4) {
    try {
      const decoded = Buffer.from(pwd, "base64").toString("utf8");
      // Verificar que el resultado sea texto legible (no caracteres extraños)
      if (/^[\x20-\x7E]+$/.test(decoded)) {
        console.log("[DISCOVERY] Contraseña decodificada de Base64");
        return decoded;
      }
    } catch (e) {
      // No es Base64 válido, devolver original
    }
  }
  return pwd;
}

/**
 * Parsea un archivo .ini para extraer configuración de conexión
 * Soporta formato National Soft con sección [MULTIDIOMAS]
 * @param {string} filePath - Ruta al archivo .ini
 * @returns {object|null} - Configuración de conexión o null
 */
function parseIniConfig(filePath) {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split(/\r?\n/);

    const config = {};
    let currentSection = "";
    let autenticacion = null;

    for (const line of lines) {
      const trimmed = line.trim();

      // Sección [Database], [Connection], [MULTIDIOMAS], etc.
      const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
      if (sectionMatch) {
        currentSection = sectionMatch[1].toLowerCase();
        continue;
      }

      // Key=Value
      const keyValueMatch = trimmed.match(/^([^=]+)=(.*)$/);
      if (keyValueMatch) {
        const key = keyValueMatch[1].trim().toLowerCase();
        const value = keyValueMatch[2].trim();

        // Mapear keys comunes (incluyendo formato National Soft)
        if (
          key === "server" ||
          key === "datasource" ||
          key === "host" ||
          key === "servidor"
        ) {
          config.server = value;
        } else if (
          key === "database" ||
          key === "initialcatalog" ||
          key === "catalog" ||
          key === "basedatos"
        ) {
          config.database = value;
        } else if (
          key === "user" ||
          key === "userid" ||
          key === "username" ||
          key === "usuario"
        ) {
          config.user = value;
        } else if (
          key === "password" ||
          key === "pwd" ||
          key === "clave" ||
          key === "contrasena"
        ) {
          // National Soft codifica la contraseña en Base64
          config.password = decodePassword(value);
        } else if (key === "port" || key === "puerto") {
          config.port = parseInt(value) || 1433;
        } else if (key === "autenticacion") {
          // National Soft: autenticacion=2 significa SQL Auth
          autenticacion = parseInt(value);
        }
      }
    }

    // Determinar tipo de autenticación
    if (autenticacion === 2) {
      config.integratedSecurity = false; // SQL Auth
    } else if (autenticacion === 1) {
      config.integratedSecurity = true; // Windows Auth
    }

    if (config.server || config.database) {
      console.log("[DISCOVERY] Configuración encontrada en:", filePath);
      console.log(
        "[DISCOVERY] Server:",
        config.server,
        "DB:",
        config.database,
        "User:",
        config.user || "Windows Auth",
      );
      return config;
    }
  } catch (e) {
    console.log(`[DISCOVERY] Error parseando ${filePath}: ${e.message}`);
  }

  return null;
}

// Parsea un archivo de texto con connection string
function parseTxtConfig(filePath) {
  try {
    const content = fs.readFileSync(filePath, "utf8");

    // Buscar connection string en el contenido
    const parsed = parseConnectionString(content);
    if (parsed && parsed.server) {
      console.log(`[DISCOVERY] Connection string encontrada en: ${filePath}`);
      return parsed;
    }

    // También buscar línea por línea
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      const parsed = parseConnectionString(line);
      if (parsed && parsed.server) {
        return parsed;
      }
    }
  } catch (e) {
    console.log(`[DISCOVERY] Error parseando ${filePath}: ${e.message}`);
  }

  return null;
}

// Parsea una connection string estándar de SQL Server
function parseConnectionString(connStr) {
  if (!connStr) return null;

  const config = {};

  // Patrones comunes en connection strings
  const patterns = [
    { regex: /Data Source\s*=\s*([^;]+)/i, key: "server" },
    { regex: /Server\s*=\s*([^;]+)/i, key: "server" },
    { regex: /Initial Catalog\s*=\s*([^;]+)/i, key: "database" },
    { regex: /Database\s*=\s*([^;]+)/i, key: "database" },
    { regex: /User Id\s*=\s*([^;]+)/i, key: "user" },
    { regex: /User\s*=\s*([^;]+)/i, key: "user" },
    { regex: /Uid\s*=\s*([^;]+)/i, key: "user" },
    { regex: /Password\s*=\s*([^;]+)/i, key: "password" },
    { regex: /Pwd\s*=\s*([^;]+)/i, key: "password" },
    { regex: /Integrated Security\s*=\s*([^;]+)/i, key: "integratedSecurity" },
  ];

  for (const pattern of patterns) {
    const match = connStr.match(pattern.regex);
    if (match) {
      let value = match[1].trim();
      if (pattern.key === "integratedSecurity") {
        value =
          value.toLowerCase() === "true" || value.toLowerCase() === "sspi";
      }
      config[pattern.key] = value;
    }
  }

  // Extraer puerto si está en el server (ej: localhost,1433 o localhost\SQLEXPRESS)
  if (config.server) {
    const portMatch = config.server.match(/,(\d+)$/);
    if (portMatch) {
      config.port = parseInt(portMatch[1]);
      config.server = config.server.replace(/,\d+$/, "");
    }
  }

  return Object.keys(config).length > 0 ? config : null;
}

// Busca y extrae automáticamente la configuración de SQL Server de los archivos de Soft Restaurant
function discoverSqlConfig() {
  console.log(
    "[DISCOVERY] Iniciando búsqueda de configuración de Soft Restaurant...",
  );

  // 1. Primero intentar leer del registro de Windows
  console.log("[DISCOVERY] Buscando en registro de Windows...");
  const regConfig = readFromRegistry();
  if (regConfig && regConfig.server) {
    console.log("[DISCOVERY] Configuración encontrada en el registro");
    const normalized = {
      server: regConfig.server,
      database: normalizeDatabaseName(regConfig.database),
      port: regConfig.port || 1433,
      user: regConfig.user || null,
      password: regConfig.password || null,
      integratedSecurity: regConfig.integratedSecurity || !regConfig.user,
    };
    return {
      found: true,
      config: normalized,
      source: "Windows Registry",
    };
  }

  // 2. Buscar directorios de Soft Restaurant
  const dirs = findSoftRestaurantDirs();

  if (dirs.length === 0) {
    console.log("[DISCOVERY] No se encontraron directorios de Soft Restaurant");
    // Devolver servidores conocidos para intentar
    return {
      found: false,
      message: "No se encontró instalación de Soft Restaurant",
      knownServers: getKnownServers(),
      commonDatabases: COMMON_DATABASE_NAMES,
    };
  }

  // 3. Buscar archivos de configuración en cada directorio
  for (const dir of dirs) {
    const configFiles = findConfigFiles(dir);

    for (const configFile of configFiles) {
      let config = null;
      const lowerFile = configFile.toLowerCase();

      if (lowerFile.endsWith(".config") || lowerFile.endsWith(".xml")) {
        config = parseNetConfig(configFile);
      } else if (lowerFile.endsWith(".ini")) {
        config = parseIniConfig(configFile);
      } else if (lowerFile.endsWith(".txt")) {
        config = parseTxtConfig(configFile);
      }

      if (config && config.server) {
        let server = config.server;
        let serverName = server;
        let instanceName = null;
        let dynamicPort = null;

        // Extraer nombre del servidor e instancia
        if (server.includes("\\")) {
          const parts = server.split("\\");
          serverName = parts[0];
          instanceName = parts[1];

          // Obtener puerto dinámico del registro local
          dynamicPort = getDynamicPort(instanceName);
          if (dynamicPort) {
            console.log("[DISCOVERY] Puerto dinámico encontrado:", dynamicPort);
          }
        }

        // Si el servidor es local, intentar usar IP del VPN y crear regla de firewall
        if (isLocalServer(serverName)) {
          const vpnIp = getVpnIp();
          if (vpnIp) {
            console.log(
              "[DISCOVERY] Servidor local detectado, usando IP VPN:",
              vpnIp,
            );
            serverName = vpnIp;
          }

          // Crear regla de firewall para el puerto dinámico
          if (dynamicPort) {
            const fwResult = createFirewallRule(dynamicPort, instanceName);
            if (!fwResult.success && fwResult.requiresAdmin) {
              // Intentar con elevación
              console.log(
                "[DISCOVERY] Intentando crear regla con permisos elevados...",
              );
              createFirewallRuleElevated(dynamicPort, instanceName);
            }
          }
        }

        // Reconstruir el string del servidor
        // Si tenemos puerto, usar formato IP,PUERTO (sin instancia)
        // Si no tenemos puerto, usar formato IP\INSTANCIA (para SQL Browser)
        if (dynamicPort) {
          server = `${serverName},${dynamicPort}`;
          console.log("[DISCOVERY] Servidor con puerto directo:", server);
        } else if (instanceName) {
          server = `${serverName}\\${instanceName}`;
          console.log(
            "[DISCOVERY] Servidor con instancia (requiere SQL Browser):",
            server,
          );
        } else {
          server = serverName;
        }

        // Normalizar la configuración
        const normalized = {
          server: server,
          database: normalizeDatabaseName(config.database),
          user: config.user || null,
          password: config.password || null,
        };

        console.log("[DISCOVERY] Configuración encontrada exitosamente");
        console.log("[DISCOVERY] Server:", normalized.server);
        console.log("[DISCOVERY] Database:", normalized.database);
        console.log("[DISCOVERY] User:", normalized.user || "(sin usuario)");

        // Detectar VPN disponible para mostrar como opción
        const vpnIp = getVpnIp();
        if (vpnIp) {
          console.log("[DISCOVERY] VPN detectada:", vpnIp);
        }

        return {
          found: true,
          config: normalized,
          source: configFile,
          vpnIp: vpnIp || null,
        };
      }
    }
  }

  console.log("[DISCOVERY] No se encontró configuración de SQL Server");
  return {
    found: false,
    message: "Se encontró Soft Restaurant pero no la configuración de SQL",
    dirs: dirs,
    knownServers: getKnownServers(),
    commonDatabases: COMMON_DATABASE_NAMES,
  };
}

// Obtiene información de diagnóstico sobre la instalación de Soft Restaurant
function getDiagnostics() {
  const diagnostics = {
    searchPaths: SEARCH_PATHS,
    foundDirs: [],
    foundConfigs: [],
    knownServers: getKnownServers(),
    knownInstances: KNOWN_SQL_INSTANCES,
    commonDatabases: COMMON_DATABASE_NAMES,
    registryConfig: null,
    systemInfo: {
      platform: process.platform,
      arch: process.arch,
      hostname: os.hostname(),
    },
  };

  // Buscar en registro
  try {
    diagnostics.registryConfig = readFromRegistry();
  } catch (e) {
    diagnostics.registryError = e.message;
  }

  // Buscar directorios
  diagnostics.foundDirs = findSoftRestaurantDirs();

  // Buscar configs en cada directorio
  for (const dir of diagnostics.foundDirs) {
    const configs = findConfigFiles(dir);
    diagnostics.foundConfigs.push(...configs);
  }

  // Intentar parsear el primer config encontrado
  if (diagnostics.foundConfigs.length > 0) {
    const firstConfig = diagnostics.foundConfigs[0];
    if (firstConfig.toLowerCase().endsWith(".ini")) {
      diagnostics.parsedConfig = parseIniConfig(firstConfig);
    }
  }

  return diagnostics;
}

module.exports = {
  discoverSqlConfig,
  findSoftRestaurantDirs,
  findConfigFiles,
  parseConnectionString,
  parseIniConfig,
  getDiagnostics,
  getKnownServers,
  getDynamicPort,
  getVpnIp,
  isLocalServer,
  firewallRuleExists,
  createFirewallRule,
  createFirewallRuleElevated,
  readFromRegistry,
  decodePassword,
  COMMON_DATABASE_NAMES,
  KNOWN_SQL_INSTANCES,
};
