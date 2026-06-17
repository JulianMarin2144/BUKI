# Preguntas para BUKI — Integración BUK HR

Listado completo de consultas que puedes hacerle al bot con la integración BUK activa.

---

## Empleados — Conteos y totales

- ¿Cuántos empleados activos hay en la empresa?
- ¿Cuántos empleados inactivos hay?
- ¿Cuántos empleados hay en total incluyendo activos e inactivos?
- Dame el conteo de empleados por estado.

---

## Empleados — Listados

- Lista los primeros 25 empleados activos.
- Muéstrame los empleados de la página 2.
- ¿Qué empleados hay en el área de litigios?
- ¿Qué empleados hay en el área de administrativo?
- Lista los empleados del área de contabilidad.
- ¿Hay algún empleado llamado Julián Marín?
- Busca empleados con el apellido García.
- ¿Qué empleados hay en el área de recursos humanos?

---

## Empleados — Perfil individual

- Dame el perfil completo de Sergio Acevedo.
- Busca a Julián Marín y muéstrame su información completa.
- ¿Cuál es el cargo de [nombre del empleado]?
- ¿Qué área tiene asignada [nombre del empleado]?
- ¿Cuál es la fecha de ingreso de [nombre del empleado]?
- ¿Cuándo empezó [nombre del empleado] en su cargo actual?
- ¿Cuál es el tipo de contrato de [nombre del empleado]?
- ¿Cuál es la EPS de [nombre del empleado]?
- ¿Cuál es el fondo de pensiones (AFP) de [nombre del empleado]?
- ¿Cuál es el correo electrónico de [nombre del empleado]?
- ¿Cuál es el teléfono de [nombre del empleado]?
- ¿Cuál es el documento de identidad de [nombre del empleado]?
- Muéstrame el historial de cargos de [nombre del empleado].
- ¿Cuántos años lleva [nombre del empleado] en la empresa?
- Dame el perfil del empleado con ID 2291.

---

## Ausencias

- ¿Hay ausencias registradas en la empresa?
- Muéstrame todas las ausencias registradas.
- ¿Qué ausencias tiene el empleado [nombre]?
- ¿Quién ha tenido ausencias este año?
- Muéstrame las ausencias desde el 2025-01-01.
- ¿Cuántas ausencias hay registradas en total?

---

## Vacaciones

- ¿Qué vacaciones están aprobadas?
- Muéstrame todas las solicitudes de vacaciones.
- ¿Qué vacaciones tiene aprobadas [nombre del empleado]?
- ¿Cuántos días de vacaciones tiene disponibles el empleado con ID [id]?
- ¿Hay algún empleado de vacaciones actualmente?

---

## Licencias y permisos

- ¿Hay licencias registradas?
- Muéstrame los permisos e impedimentos registrados.
- ¿Tiene alguna licencia el empleado [nombre]?
- ¿Qué tipos de licencias hay registradas?

---

## Combinadas (requieren dos pasos internos del bot)

- Busca a Julián Marín y dime cuántos días de vacaciones tiene disponibles.
- ¿Cuál es el área de Sergio Acevedo y qué ausencias tiene registradas?
- Dame el perfil completo del empleado con más antigüedad que encuentres.
- ¿Qué empleados del área de litigios tienen ausencias registradas?

---

## Notas de uso

- Los nombres son **insensibles a tildes**: puedes escribir `Julian Marin` o `Julián Marín`, ambos funcionan.
- La búsqueda por nombre es **parcial y por palabras**: `marin` encuentra "Julián Nevardo Marín Marín".
- Para obtener el perfil completo de un empleado, el bot primero busca por nombre y luego consulta el detalle por `person_id` automáticamente.
- Los campos `hire_date` y `current_job_start` son distintos: el primero es la fecha de ingreso a la empresa, el segundo es cuando inició en el cargo actual.
- Las ausencias y licencias se obtienen del mismo endpoint BUK (`/absences`); las licencias se filtran por tipo.
