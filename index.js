const functions = require("firebase-functions/v1");
const admin = require("firebase-admin");
admin.initializeApp();

const LV = { rector: 5, vicerrector: 4, decano: 3, director: 2, docente: 1, estudiante: 0 };
const emailKey = (c) => String(c || "").trim().toLowerCase().replace(/[.#$\[\]\/]/g, ",");

exports.borrarPersona = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Debes iniciar sesión.");
  const db = admin.database();

  // Quién llama y qué nivel tiene (se lee del servidor, no se confía en el navegador)
  const quien = (await db.ref("panel/" + context.auth.uid).once("value")).val();
  if (!quien || !(quien.rol in LV)) throw new functions.https.HttpsError("permission-denied", "Perfil no válido.");

  const id = String(data && data.id || "");
  if (!id) throw new functions.https.HttpsError("invalid-argument", "Falta el id.");
  const u = (await db.ref("usuarios/" + id).once("value")).val();
  if (!u) throw new functions.https.HttpsError("not-found", "La persona ya no existe.");

  // Solo se puede borrar a niveles inferiores
  if (!(u.rol in LV) || LV[u.rol] >= LV[quien.rol])
    throw new functions.https.HttpsError("permission-denied", "No tienes autoridad sobre este nivel.");

  const mail = String(u.correo || "").toLowerCase();
  let uid = u.uid || null;

  // 1) Borra la cuenta de Authentication
  if (!uid && mail) {
    try { uid = (await admin.auth().getUserByEmail(mail)).uid; } catch (e) { /* no tenía cuenta */ }
  }
  if (uid) {
    try { await admin.auth().deleteUser(uid); }
    catch (e) { if (e.code !== "auth/user-not-found") throw new functions.https.HttpsError("internal", "No se pudo borrar la cuenta."); }
  }

  // 2) Limpia la base de datos
  const up = {};
  up["usuarios/" + id] = null;
  if (uid) { up["panel/" + uid] = null; up["biometria/" + uid] = null; }
  if (mail) up["eliminados/" + emailKey(mail)] = { nombre: u.nombre, por: quien.nombre, ts: Date.now() };
  await db.ref().update(up);

  // 3) Avisa al lector ESP32 para que borre la huella
  if (/^\d+$/.test(id)) await db.ref("borrar").set({ id: +id });

  return { ok: true };
});

// ===== Inicio de sesión: el servidor escribe el perfil y el nivel (el navegador no puede) =====
const RECTOR = "correo.del.rector@unipamplona.edu.co"; // ← correo real del Rector (debe existir en Authentication)

exports.iniciarSesion = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Debes iniciar sesión.");
  const db = admin.database();
  const email = String(context.auth.token.email || "").toLowerCase();
  const esRector = email === RECTOR.toLowerCase();
  if (!esRector && (await db.ref("eliminados/" + emailKey(email)).once("value")).exists())
    throw new functions.https.HttpsError("permission-denied", "Cuenta eliminada por la universidad.");

  const us = (await db.ref("usuarios").once("value")).val() || {};
  const id = Object.keys(us).find((k) => String(us[k].correo || "").toLowerCase() === email);
  const reg = id ? us[id] : null;
  if (!reg && !esRector) throw new functions.https.HttpsError("permission-denied", "Correo no registrado.");

  const bonito = email.split("@")[0].split(/[._-]+/).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");
  const perfil = { id: id || "", nombre: reg ? reg.nombre : bonito, rol: esRector ? "rector" : reg.rol, correo: email };
  if (!(perfil.rol in LV)) throw new functions.https.HttpsError("permission-denied", "Rol no válido.");
  perfil.lv = LV[perfil.rol];

  // niveles: tabla que usan las reglas para comparar jerarquías
  await db.ref().update({ ["panel/" + context.auth.uid]: perfil, niveles: LV });
  return perfil;
});
