/**
 * Even Agent - Main Process
 * Integra sincronización con Soft Restaurant via WebSocket
 */

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  nativeImage,
  Notification,
} = require("electron");

app.setName("Even");
app.setAppUserModelId("com.even.agent");

// Registrar AUMID en Windows para que las notificaciones muestren "Even"
const { execSync } = require("child_process");
try {
  execSync(
    `powershell -Command "` +
      `New-Item -Path 'HKCU:\\SOFTWARE\\Classes\\AppUserModelId\\com.even.agent' -Force | Out-Null;` +
      `New-ItemProperty -Path 'HKCU:\\SOFTWARE\\Classes\\AppUserModelId\\com.even.agent' -Name 'DisplayName' -Value 'Even' -Force | Out-Null` +
      `"`,
    { windowsHide: true },
  );
} catch (e) {
  // No crítico, continúa sin el registro
}

// Quitar menú de la ventana
Menu.setApplicationMenu(null);
const path = require("path");
const fs = require("fs");
const { io } = require("socket.io-client");

// Módulos internos
const {
  connectSqlServer,
  closeConnection,
  getActiveTurno,
} = require("./database");
const {
  insertOrder,
  applyPayment,
  addItemsToOrder,
  getChecksByTable,
  transformOrder,
} = require("./orders");
const { setupSyncHandlers } = require("./sync");
const {
  discoverPrinters,
  listLocalPrinters,
  setupPrinterHandlers,
  setupPrinterTestHandler,
  setupUsbPrinterHandlers,
} = require("./printers");
const {
  setPrinters,
  printOrderTickets,
  printJobFromBackend,
} = require("./printing");
const sqlOnboarding = require("./sqlOnboarding");

let mainWindow = null;
let tray = null;
let isConnected = false;
let configPath = null;
let isQuitting = false;

// Agent state
let syncSocket = null;
let pingInterval = null;
let currentConfig = null;

// ============================================
// Logs al Renderer
// ============================================

const originalLog = console.log;
const originalError = console.error;

function sendLogToRenderer(type, args) {
  const msg = args
    .map((a) =>
      typeof a === "object" ? JSON.stringify(a, null, 2) : String(a),
    )
    .join(" ");
  if (mainWindow && mainWindow.webContents) {
    // Escapar caracteres problemáticos para JS string
    const escaped = msg
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "\\'")
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t");
    mainWindow.webContents
      .executeJavaScript(`console.${type}('[AGENT] ${escaped}');`)
      .catch(() => {});
  }
}

console.log = (...args) => {
  originalLog(...args);
  sendLogToRenderer("log", args);
};

console.error = (...args) => {
  originalError(...args);
  sendLogToRenderer("error", args);
};

// ============================================
// Configuración
// ============================================

function getConfigPath() {
  if (!configPath) {
    const isDev = !app.isPackaged;
    configPath = isDev
      ? path.join(__dirname, "..", "config.json")
      : path.join(app.getPath("userData"), "config.json");
  }
  return configPath;
}

function configExists() {
  return fs.existsSync(getConfigPath());
}

function getConfig() {
  if (configExists()) {
    const content = fs.readFileSync(getConfigPath(), "utf8");
    return JSON.parse(content);
  }
  return null;
}

function saveConfig(branchId, syncToken) {
  const existing = getConfig();
  const sqlConfig = existing?.sqlServer || {
    host: "localhost",
    database: "softrestaurant10",
    port: 1433,
  };

  const config = {
    sqlServer: sqlConfig,
    even: {
      branchId: branchId,
      syncToken: syncToken,
      wsUrl: "https://even-backend-production.up.railway.app/sync",
      //wsUrl: "http://localhost:5000/sync",
    },
  };
  fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), "utf8");
  return config;
}

// ============================================
// Agente WebSocket
// ============================================

function updateStatus(connected) {
  isConnected = connected;
  updateTray();
  if (mainWindow) {
    mainWindow.webContents.send("agent-status", { connected });
  }
}

function showLocalNotification(title, body) {
  if (Notification.isSupported()) {
    const isDev = !app.isPackaged;
    const icon = isDev
      ? path.join(__dirname, "..", "assets", "icon-white.ico")
      : path.join(
          process.resourcesPath,
          "app.asar",
          "assets",
          "icon-white.ico",
        );
    new Notification({ title, body, icon }).show();
  }
}

function sendNotification(title, body) {
  showLocalNotification(title, body);
}

function setupOrderHandlers() {
  // Nueva orden
  syncSocket.on("new_order", async (data) => {
    console.log("[ORDER] Nueva orden:", data.requestId);
    // DEBUG: Ver estructura completa de la orden
    console.log(
      "[ORDER] Datos COMPLETOS del backend:",
      JSON.stringify(data, null, 2),
    );
    try {
      const orderData = transformOrder(data);
      console.log("[ORDER] Mesa transformada:", orderData.mesa);
      const result = await insertOrder(orderData);
      console.log(
        `[ORDER] Resultado insertOrder:`,
        JSON.stringify({
          folio: result.folio,
          numcheque: result.numcheque,
          duplicate: result.duplicate ?? false,
          total: result.total,
        }),
      );
      if (result.descuento > 0) {
        console.log(`[ORDER] Descuento: $${result.descuento.toFixed(2)}`);
      }
      const details = result.itemDetails || [];
      const lines = details.map(
        (i) =>
          `${i.nombre}${i.cantidad > 1 ? ` x${i.cantidad}` : ""} — $${i.total.toFixed(2)}`,
      );
      lines.push(`Total: $${result.total.toFixed(2)}`);
      sendNotification(
        `Nueva orden - Mesa ${orderData.mesa}`,
        lines.join("\n"),
      );

      // La impresión se maneja vía print_job desde el backend (unificado con crew)

      syncSocket.emit("order_ack", {
        requestId: data.requestId,
        orderId: data.id,
        folio: result.folio,
        numcheque: result.numcheque,
        success: true,
        totals: {
          subtotal: result.subtotal,
          tax: result.tax,
          total: result.total,
          descuento: result.descuento,
        },
      });
    } catch (error) {
      console.error("[ORDER] Error:", error.message);
      syncSocket.emit("order_ack", {
        requestId: data.requestId,
        orderId: data.id,
        success: false,
        error: error.message,
      });
    }
  });

  // Aplicar pago
  syncSocket.on("apply_payment", async (data) => {
    console.log(
      `[PAYMENT] Folio ${data.folio}, $${data.amount}, propina: $${data.tip || 0}`,
    );
    try {
      const result = await applyPayment(
        data.folio,
        data.amount,
        data.tenderId,
        data.reference,
        data.tip || 0,
        data.paymentSource || null,
      );
      console.log(`[PAYMENT] ${result.status}`);
      syncSocket.emit("apply_payment_ack", {
        requestId: data.requestId,
        success: true,
        folio: data.folio,
        ...result,
      });
    } catch (error) {
      console.error("[PAYMENT] Error:", error.message);
      syncSocket.emit("apply_payment_ack", {
        requestId: data.requestId,
        success: false,
        error: error.message,
      });
    }
  });

  // Agregar items a folio existente (FlexBill - rondas)
  syncSocket.on("add_items", async (data) => {
    console.log(
      `[ADD_ITEMS] Folio ${data.folio}, ${data.items?.length || 0} items`,
    );
    try {
      const items = (data.items || []).map((item) => ({
        idproducto: item.productId || item.sku,
        cantidad: item.quantity || 1,
        precio: item.price || 0,
        impuesto: 16,
      }));

      const result = await addItemsToOrder(data.folio, items);
      console.log(`[ADD_ITEMS] ${result.itemsAdded} items agregados`);
      sendNotification(
        `Productos agregados - Folio ${data.folio}`,
        `${result.itemsAdded} producto(s) agregado(s)`,
      );
      syncSocket.emit("add_items_ack", {
        requestId: data.requestId,
        success: true,
        folio: data.folio,
        ...result,
      });
    } catch (error) {
      console.error("[ADD_ITEMS] Error:", error.message);
      syncSocket.emit("add_items_ack", {
        requestId: data.requestId,
        success: false,
        error: error.message,
      });
    }
  });

  // Obtener cheques por mesa (Tap&Pay)
  syncSocket.on("get_checks_by_table", async (data) => {
    try {
      const result = await getChecksByTable(
        data.table,
        data.includeClosed || false,
      );
      console.log(
        `[GET_CHECKS] Mesa ${data.table}: ${result.checks.length} cheque(s)`,
      );
      syncSocket.emit("get_checks_by_table_ack", {
        requestId: data.requestId,
        success: true,
        ...result,
      });
    } catch (error) {
      console.error("[GET_CHECKS] Error:", error.message);
      syncSocket.emit("get_checks_by_table_ack", {
        requestId: data.requestId,
        success: false,
        error: error.message,
      });
    }
  });
}

async function startAgent() {
  const config = getConfig();
  if (!config) return;

  currentConfig = config;
  console.log("[AGENT] Iniciando...");

  try {
    await connectSqlServer(config);

    const turno = await getActiveTurno();
    console.log(
      turno
        ? `[SQL] Turno activo: ${turno.idturno}`
        : "[SQL] No hay turno abierto",
    );

    // WebSocket connection
    const wsUrl = config.even.wsUrl.replace("/sync", "");
    syncSocket = io(`${wsUrl}/sync`, {
      transports: ["websocket"],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: Infinity,
      timeout: 30000,
      pingTimeout: 30000,
      pingInterval: 15000,
      forceNew: false,
    });

    function registerWithServer() {
      if (syncSocket && syncSocket.connected) {
        console.log("[WS] Enviando registro...");
        syncSocket.emit("register", {
          branchId: config.even.branchId,
          syncToken: config.even.syncToken,
          agentVersion: "1.0.0",
        });
      }
    }

    function startHeartbeat() {
      stopHeartbeat();
      pingInterval = setInterval(() => {
        if (syncSocket && syncSocket.connected) {
          syncSocket.emit("ping");
        }
      }, 15000);
    }

    function stopHeartbeat() {
      if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
      }
    }

    syncSocket.on("register_ack", (data) => {
      console.log("[WS] Registrado:", data.message || "OK");
    });

    syncSocket.on("printers_config", (data) => {
      console.log(
        `[PRINT] Configuración recibida: ${data.printers?.length || 0} impresora(s)`,
      );
      setPrinters(data.printers || []);
    });

    // Trabajo de impresión desde backend (FlexBill, Tap, Room, Pick&Go)
    // Emite print_job_ack tras imprimir exitosamente (o si no hay impresoras → auto-ACK en backend)
    syncSocket.on("print_job", (data) => {
      printJobFromBackend(data)
        .then(() => {
          if (data.jobId) {
            syncSocket.emit("print_job_ack", { jobId: data.jobId });
          }
        })
        .catch((err) => {
          console.error("[PRINT] Error en print_job:", err.message);
          // Sin ACK en error → backend reintenta tras timeout
        });
    });

    syncSocket.on("register_error", (data) => {
      console.error("[WS] Error registro:", data.error);
      updateStatus(false);
    });

    syncSocket.on("connect", () => {
      console.log("[WS] Conectado!");
      updateStatus(true);
      registerWithServer();
      startHeartbeat();
    });

    syncSocket.on("pong", () => {});

    syncSocket.on("disconnect", (reason) => {
      console.log("[WS] Desconectado:", reason);
      stopHeartbeat();
      if (
        reason === "io server disconnect" ||
        reason === "io client disconnect"
      ) {
        updateStatus(false);
      }
    });

    syncSocket.on("reconnect", (attemptNumber) => {
      console.log(`[WS] Reconectado después de ${attemptNumber} intentos`);
      updateStatus(true);
      registerWithServer();
      startHeartbeat();
    });

    syncSocket.on("reconnect_attempt", (attemptNumber) => {
      if (attemptNumber % 5 === 1) {
        console.log(`[WS] Intento de reconexión #${attemptNumber}`);
      }
    });

    syncSocket.on("connect_error", (error) => {
      console.error("[WS] Error conexión:", error.message);
      if (!syncSocket.active) {
        updateStatus(false);
      }
    });

    // Setup handlers
    setupOrderHandlers();
    setupSyncHandlers(syncSocket);
    setupPrinterHandlers(syncSocket);
    setupPrinterTestHandler(syncSocket);
    setupUsbPrinterHandlers(syncSocket);
  } catch (error) {
    console.error("[AGENT] Error:", error.message);
    updateStatus(false);
  }
}

async function stopAgent() {
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }

  if (syncSocket) {
    syncSocket.close();
    syncSocket = null;
  }

  await closeConnection();
  updateStatus(false);
  console.log("[AGENT] Detenido");
}

async function restartAgent() {
  await stopAgent();
  setTimeout(startAgent, 500);
}

// ============================================
// Tray
// ============================================

function createTrayIcon(connected) {
  const size = 32;
  const canvas = Buffer.alloc(size * size * 4);
  // Buffer format on Windows is BGRA, so store as [B, G, R]
  const [r, g, b] = connected ? [87, 230, 130] : [68, 68, 239];

  const cx = 15.5;
  const cy = 15.5;
  const halfLen = 12;
  const halfWidth = 3.2;

  function distToSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
    return Math.sqrt((px - (ax + t * dx)) ** 2 + (py - (ay + t * dy)) ** 2);
  }

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const idx = (py * size + px) * 4;
      let inShape = false;

      for (let i = 0; i < 3; i++) {
        const angle = (i * 60 * Math.PI) / 180;
        const cosA = Math.cos(angle), sinA = Math.sin(angle);
        const ax = cx - halfLen * cosA, ay = cy - halfLen * sinA;
        const bx = cx + halfLen * cosA, by = cy + halfLen * sinA;
        if (distToSegment(px, py, ax, ay, bx, by) <= halfWidth) {
          inShape = true;
          break;
        }
      }

      if (inShape) {
        canvas[idx] = r;
        canvas[idx + 1] = g;
        canvas[idx + 2] = b;
        canvas[idx + 3] = 255;
      } else {
        canvas[idx + 3] = 0;
      }
    }
  }

  return nativeImage.createFromBuffer(canvas, { width: size, height: size });
}

function updateTray() {
  if (!tray) return;

  tray.setImage(createTrayIcon(isConnected));
  tray.setToolTip(`Even Agent - ${isConnected ? "Conectado" : "Desconectado"}`);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: `Estado: ${isConnected ? "Conectado" : "Desconectado"}`,
      enabled: false,
    },
    { type: "separator" },
    { label: "Iniciar", click: startAgent, enabled: !syncSocket },
    { label: "Detener", click: stopAgent, enabled: !!syncSocket },
    { label: "Reiniciar", click: restartAgent, enabled: !!syncSocket },
    { type: "separator" },
    { label: "Configuracion...", click: showWindow },
    { type: "separator" },
    {
      label: "Salir",
      click: async () => {
        isQuitting = true;
        await stopAgent();
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
}

function createTray() {
  tray = new Tray(createTrayIcon(false));
  tray.setToolTip("Even Agent");
  tray.on("double-click", showWindow);
  updateTray();
}

// ============================================
// Ventana
// ============================================

function getIconPath() {
  const isDev = !app.isPackaged;
  return isDev
    ? path.join(__dirname, "..", "assets", "icon-white.ico")
    : path.join(process.resourcesPath, "app.asar", "assets", "icon-white.ico");
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 750,
    resizable: true,
    maximizable: true,
    show: false,
    backgroundColor: "#023828",
    icon: getIconPath(),
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));

  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (input.key === "F12") {
      mainWindow.webContents.toggleDevTools();
    }
  });

  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function showWindow() {
  if (!mainWindow) createWindow();

  const config = getConfig();
  mainWindow.webContents.once("did-finish-load", () => {
    mainWindow.webContents.send("load-config", config);
    mainWindow.webContents.send("agent-status", { connected: isConnected });
  });

  mainWindow.show();
  mainWindow.focus();
}

// ============================================
// IPC Handlers
// ============================================

ipcMain.handle("get-config", () => getConfig());

ipcMain.handle("save-config", async (event, { branchId, syncToken }) => {
  try {
    saveConfig(branchId, syncToken);
    await restartAgent();
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle("save-full-config", async (event, configData) => {
  try {
    const config = {
      sqlServer: {
        host: configData.sqlHost || "localhost",
        user: configData.sqlUser || "sa",
        password: configData.sqlPassword || "",
        database: configData.sqlDatabase || "softrestaurant10",
        port: parseInt(configData.sqlPort) || 1433,
      },
      even: {
        branchId: configData.branchId,
        syncToken: configData.syncToken,
        wsUrl:
          configData.wsUrl ||
          "https://even-backend-production.up.railway.app/sync",
        //wsUrl: configData.wsUrl || "http://localhost:5000/sync",
      },
    };
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), "utf8");
    await restartAgent();
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle("test-sql", async () => {
  try {
    const config = getConfig();
    if (!config) return { success: false, error: "No hay configuracion" };

    const sql = require("mssql");
    const testConfig = {
      server: config.sqlServer.host || "localhost",
      database: config.sqlServer.database || "softrestaurant10",
      port: config.sqlServer.port || 1433,
      user: config.sqlServer.user || "sa",
      password: config.sqlServer.password || "",
      options: {
        trustServerCertificate: true,
        encrypt: false,
      },
      connectionTimeout: 15000,
    };

    const testPool = await sql.connect(testConfig);
    await testPool.close();
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle("scan-printers", async () => {
  try {
    return await discoverPrinters();
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle("list-usb-printers", async () => {
  try {
    const printers = await listLocalPrinters();
    return { success: true, printers };
  } catch (error) {
    return { success: false, printers: [], error: error.message };
  }
});

ipcMain.handle("report-printers", async (event, printers) => {
  try {
    if (syncSocket && syncSocket.connected) {
      syncSocket.emit("printers_report", {
        branchId: currentConfig?.even?.branchId,
        printers,
      });
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle("get-agent-status", () => ({ connected: isConnected }));
ipcMain.handle("get-status", () => ({ connected: isConnected }));

ipcMain.handle("refresh-turno", async () => {
  try {
    // Verificar que hay conexión SQL activa
    const { getPool } = require("./database");
    const pool = getPool();
    if (!pool) {
      return { success: false, error: "SQL no conectado" };
    }

    const turno = await getActiveTurno();
    if (turno) {
      console.log(`[TURNO] Refrescado: ${turno.idturno}`);
      return {
        success: true,
        turno: { idturno: turno.idturno, apertura: turno.apertura },
      };
    } else {
      console.log("[TURNO] No hay turno abierto");
      return { success: true, turno: null };
    }
  } catch (error) {
    console.error("[TURNO] Error:", error.message);
    return { success: false, error: error.message };
  }
});

ipcMain.handle("start-agent", async () => {
  await startAgent();
  return { success: true };
});

ipcMain.handle("stop-agent", async () => {
  await stopAgent();
  return { success: true };
});

// SQL Onboarding handlers
ipcMain.handle("sql-onboarding-status", () => {
  const isConfigured = sqlOnboarding.isConfigured();
  const credentials = sqlOnboarding.getSavedCredentials();
  return { isConfigured, credentials };
});

ipcMain.handle("sql-onboarding-run", async (_event, params) => {
  return await sqlOnboarding.runOnboarding(params);
});

ipcMain.handle("sql-onboarding-test-windows", async (_event, params) => {
  return await sqlOnboarding.trySqlAuth(
    params.host,
    params.database,
    null,
    null,
  );
});

ipcMain.handle("sql-onboarding-test-sql", async (_event, params) => {
  return await sqlOnboarding.trySqlAuth(
    params.host,
    params.database,
    params.user,
    params.password,
  );
});

ipcMain.handle("sql-onboarding-create-user", async (_event, params) => {
  return await sqlOnboarding.createAppUser(params);
});

ipcMain.handle("sql-onboarding-save-windows", async (_event, params) => {
  console.log("[IPC] sql-onboarding-save-windows:", params);
  try {
    sqlOnboarding.saveCredentials({
      host: params.host,
      database: params.database,
      user: null,
      password: null,
    });
    return { success: true, configured: sqlOnboarding.isConfigured() };
  } catch (error) {
    console.error("[IPC] Error saving windows config:", error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle("sql-onboarding-save-sql", async (_event, params) => {
  console.log("[IPC] sql-onboarding-save-sql:", params);
  try {
    sqlOnboarding.saveCredentials({
      host: params.host,
      database: params.database,
      user: params.user,
      password: params.password,
    });
    return { success: true, configured: sqlOnboarding.isConfigured() };
  } catch (error) {
    console.error("[IPC] Error saving sql config:", error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle("sql-onboarding-clear", () => {
  return sqlOnboarding.clearCredentials();
});

ipcMain.handle("sql-onboarding-discover", async () => {
  return await sqlOnboarding.discoverSqlConfig();
});

ipcMain.handle("sql-onboarding-diagnostics", () => {
  return sqlOnboarding.getDiagnostics();
});

// Retorna el estado de flujo de órdenes para la sucursal actual
ipcMain.handle("get-order-flow-status", async () => {
  try {
    const config = getConfig();
    if (!config?.even?.branchId || !config?.even?.wsUrl) {
      return {
        active_count: 0,
        max_pending_orders: null,
        is_high_demand: false,
      };
    }
    const baseUrl = config.even.wsUrl.replace("/sync", "");
    const branchId = config.even.branchId;
    const res = await fetch(
      `${baseUrl}/api/branches/${branchId}/order-flow-status`,
    );
    if (!res.ok)
      return {
        active_count: 0,
        max_pending_orders: null,
        is_high_demand: false,
      };
    const { data } = await res.json();
    return data;
  } catch {
    return { active_count: 0, max_pending_orders: null, is_high_demand: false };
  }
});

// ============================================
// App Lifecycle
// ============================================

app.on("ready", () => {
  createWindow();
  createTray();
  showWindow();
  // Siempre registrar para iniciar con Windows
  if (app.isPackaged) {
    app.setLoginItemSettings({
      openAtLogin: true,
      path: process.execPath,
    });
  }

  if (configExists()) {
    startAgent();
  }
});

app.on("window-all-closed", (e) => {
  e.preventDefault();
});

app.on("before-quit", () => {
  isQuitting = true;
});
