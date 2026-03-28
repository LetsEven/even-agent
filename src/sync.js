/**
 * Sync Module - Sincronización de Menú
 * Handlers para pull/push de menú con Soft Restaurant
 */

const { sql, getPool, ensureSqlConnection } = require("./database");

// Obtener menú completo para pull (sin promociones - se aplican en órdenes)
async function getMenuData() {
  await ensureSqlConnection();
  const pool = getPool();

  // Obtener grupos
  const groupsResult = await pool.request().query(`
    SELECT idgrupo, descripcion, prioridad, clasificacion
    FROM grupos
    ORDER BY prioridad ASC, descripcion ASC
  `);

  // Obtener productos (sin promociones)
  const productsResult = await pool.request().query(`
    SELECT
      p.idproducto,
      p.descripcion,
      p.idgrupo,
      p.nombrecorto,
      p.descripcionmenuelectronico,
      p.imagen_menu,
      p.visible_menu,
      pd.precio,
      pd.preciosinimpuestos,
      pd.impuesto1,
      pd.bloqueado
    FROM productos p
    LEFT JOIN productosdetalle pd ON p.idproducto = pd.idproducto
    INNER JOIN grupos g ON p.idgrupo = g.idgrupo
    WHERE (p.visible_menu = 1 OR p.visible_menu IS NULL)
    ORDER BY p.idgrupo, p.descripcion
  `);

  return {
    groups: groupsResult.recordset,
    products: productsResult.recordset,
  };
}

// Crear nuevo grupo en Soft Restaurant
async function createGroup(name, displayOrder = 0) {
  await ensureSqlConnection();
  const pool = getPool();

  // Generar ID único de 5 caracteres
  const idgrupo =
    name
      .substring(0, 4)
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "X") + Math.floor(Math.random() * 10).toString();

  await pool
    .request()
    .input("idgrupo", sql.VarChar, idgrupo)
    .input("descripcion", sql.VarChar, name.substring(0, 30))
    .input("prioridad", sql.Numeric, displayOrder)
    .input("clasificacion", sql.Numeric, 1).query(`
      INSERT INTO grupos (idgrupo, descripcion, prioridad, clasificacion, alcohol)
      VALUES (@idgrupo, @descripcion, @prioridad, @clasificacion, 0)
    `);

  return { idgrupo, descripcion: name };
}

// Crear nuevo producto en Soft Restaurant
async function createProduct(data) {
  await ensureSqlConnection();
  const pool = getPool();

  // Generar ID de producto (15 chars max)
  const timestamp = Date.now().toString().slice(-8);
  const idproducto = `XQ${timestamp}`;
  const precioSinImp = data.price / 1.16; // Asumir 16% IVA

  // Insertar en productos
  await pool
    .request()
    .input("idproducto", sql.VarChar, idproducto)
    .input("descripcion", sql.VarChar, data.name.substring(0, 60))
    .input("idgrupo", sql.VarChar, data.groupId)
    .input("nombrecorto", sql.VarChar, data.name.substring(0, 20))
    .input(
      "descripcionmenuelectronico",
      sql.VarChar,
      (data.description || "").substring(0, 255),
    )
    .input("visible_menu", sql.Bit, 1).query(`
      INSERT INTO productos (
        idproducto, descripcion, idgrupo, nombrecorto,
        descripcionmenuelectronico, visible_menu,
        descripcion_detalle, calorias, capturar_pendientes,
        id_etiqueta, id_etiqueta_descripcion, idprodserv_SAT,
        usarVectorPlus, imagenme_modified, monitoreo
      )
      VALUES (
        @idproducto, @descripcion, @idgrupo, @nombrecorto,
        @descripcionmenuelectronico, @visible_menu,
        '', 0, 0,
        '', '', '',
        0, 0, 0
      )
    `);

  // Insertar en productosdetalle (precios)
  await pool
    .request()
    .input("idproducto", sql.VarChar, idproducto)
    .input("idempresa", sql.VarChar, "1")
    .input("precio", sql.Money, data.price)
    .input("preciosinimpuestos", sql.Money, precioSinImp)
    .input("impuesto1", sql.Numeric, 16)
    .input("bloqueado", sql.Bit, 0).query(`
      INSERT INTO productosdetalle (
        idproducto, idempresa, precio, preciosinimpuestos,
        impuesto1, impuesto2, impuesto3, bloqueado,
        precioabierto, canjeablepuntos
      )
      VALUES (
        @idproducto, @idempresa, @precio, @preciosinimpuestos,
        @impuesto1, 0, 0, @bloqueado,
        0, 0
      )
    `);

  return { idproducto, descripcion: data.name, precio: data.price };
}

// Configura los handlers de sync en el socket
function setupSyncHandlers(syncSocket) {
  // Pull de menú
  syncSocket.on("sync_menu_pull", async (data) => {
    console.log("[SYNC] ========================================");
    console.log("[SYNC] Pull de menú solicitado, requestId:", data.requestId);
    try {
      const menuData = await getMenuData();

      console.log(
        `[SYNC] Grupos: ${menuData.groups.length}, Productos: ${menuData.products.length}`,
      );

      syncSocket.emit("sync_menu_pull_ack", {
        requestId: data.requestId,
        success: true,
        groups: menuData.groups,
        products: menuData.products,
      });
      console.log("[SYNC] Respuesta enviada correctamente");
    } catch (error) {
      console.error("[SYNC] ❌ Error en pull:", error);
      console.error("[SYNC] Stack:", error.stack);
      syncSocket.emit("sync_menu_pull_ack", {
        requestId: data.requestId,
        success: false,
        error: error.message,
      });
    }
  });

  // Push de grupo
  syncSocket.on("sync_menu_push_group", async (data) => {
    console.log(`[SYNC] Crear grupo: ${data.name}`);
    try {
      const result = await createGroup(data.name, data.displayOrder);
      console.log(`[SYNC] Grupo creado: ${result.idgrupo}`);

      syncSocket.emit("sync_menu_push_group_ack", {
        requestId: data.requestId,
        success: true,
        ...result,
      });
    } catch (error) {
      console.error("[SYNC] Error creando grupo:", error.message);
      syncSocket.emit("sync_menu_push_group_ack", {
        requestId: data.requestId,
        success: false,
        error: error.message,
      });
    }
  });

  // Push de producto
  syncSocket.on("sync_menu_push_product", async (data) => {
    console.log(`[SYNC] Crear producto: ${data.name}`);
    try {
      const result = await createProduct(data);
      console.log(`[SYNC] Producto creado: ${result.idproducto}`);

      syncSocket.emit("sync_menu_push_product_ack", {
        requestId: data.requestId,
        success: true,
        ...result,
      });
    } catch (error) {
      console.error("[SYNC] Error creando producto:", error.message);
      syncSocket.emit("sync_menu_push_product_ack", {
        requestId: data.requestId,
        success: false,
        error: error.message,
      });
    }
  });
}

module.exports = {
  getMenuData,
  createGroup,
  createProduct,
  setupSyncHandlers,
};
