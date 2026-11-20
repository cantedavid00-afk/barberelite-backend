// security/public-views.js
//
// Vistas públicas de datos que el portal de clientes necesita sin sesión.
// El portal solo usa la ocupación de la agenda (fecha, hora, servicio, estado)
// para pintar huecos libres; nombre, teléfono, email y comentarios de otros
// clientes no deben salir de la API sin autenticación.

function toPublicCita(cita) {
  return {
    fecha: cita.fecha,
    hora: cita.hora,
    estado: cita.estado,
    servicio_id: cita.servicio_id,
    empleado_id: cita.empleado_id ?? null,
  };
}

function toPublicEmpleado(emp) {
  // Sin teléfono: el cliente elige barbero por nombre/especialidad/categoría.
  const { telefono, ...rest } = emp; // eslint-disable-line no-unused-vars
  return rest;
}

module.exports = { toPublicCita, toPublicEmpleado };
