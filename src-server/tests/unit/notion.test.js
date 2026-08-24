/**
 * src-server/tests/unit/notion.test.js
 *
 * Tests unitarios de las funciones puras de src-server/services/notion.js (I6).
 *
 * - Usa `node:test` como el resto de la suite (no Vitest: cero dependencias nuevas).
 * - No toca red ni Notion: solo funciones puras y helpers de lotes con fns inyectadas.
 * - Documenta el CONTRATO ACTUAL, quirks incluidos (marcados "quirk documentado"):
 *   cambiarlos es un breaking change para el frontend, no un fix gratis.
 *
 * Ejecución: `npm run test:unit` (incluido en `npm test`).
 */

process.env.NOTION_TOKEN = process.env.NOTION_TOKEN || 'mock'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
	extractPropertyValue,
	buildEstadoUpdatePayload,
	enLotes,
	conReintento429,
	mapObra,
	mapJefeObra,
	mapFirmanteAutorizado,
	mapEmpleado,
	mapParte,
	mapDetalle
} = require('../../services/notion')

// ─── extractPropertyValue ────────────────────────────────────────────────────

test('extractPropertyValue: propiedad ausente o sin type devuelve ""', () => {
	assert.equal(extractPropertyValue(undefined), '')
	assert.equal(extractPropertyValue(null), '')
	assert.equal(extractPropertyValue({}), '')
})

test('extractPropertyValue: title y rich_text leen el primer plain_text', () => {
	assert.equal(extractPropertyValue({ type: 'title', title: [{ plain_text: 'Obra X' }] }), 'Obra X')
	assert.equal(extractPropertyValue({ type: 'title', title: [] }), '')
	assert.equal(extractPropertyValue({ type: 'rich_text', rich_text: [{ plain_text: 'nota' }] }), 'nota')
	assert.equal(extractPropertyValue({ type: 'rich_text', rich_text: [] }), '')
})

test('extractPropertyValue: number — null devuelve 0, y 0 devuelve 0 (quirk documentado: `|| 0`)', () => {
	assert.equal(extractPropertyValue({ type: 'number', number: 8 }), 8)
	assert.equal(extractPropertyValue({ type: 'number', number: null }), 0)
	assert.equal(extractPropertyValue({ type: 'number', number: 0 }), 0)
})

test('extractPropertyValue: select / status / multi_select', () => {
	assert.equal(extractPropertyValue({ type: 'select', select: { name: 'Activa' } }), 'Activa')
	assert.equal(extractPropertyValue({ type: 'select', select: null }), '')
	assert.equal(extractPropertyValue({ type: 'status', status: { name: 'Borrador' } }), 'Borrador')
	assert.equal(extractPropertyValue({ type: 'status', status: null }), '')
	assert.equal(extractPropertyValue({
		type: 'multi_select',
		multi_select: [{ name: 'A' }, { name: 'B' }]
	}), 'A, B')
	assert.equal(extractPropertyValue({ type: 'multi_select', multi_select: [] }), '')
})

test('extractPropertyValue: date devuelve start; sin date devuelve ""', () => {
	assert.equal(extractPropertyValue({ type: 'date', date: { start: '2026-08-24' } }), '2026-08-24')
	assert.equal(extractPropertyValue({ type: 'date', date: null }), '')
})

test('extractPropertyValue: checkbox — true pasa, false devuelve false', () => {
	assert.equal(extractPropertyValue({ type: 'checkbox', checkbox: true }), true)
	assert.equal(extractPropertyValue({ type: 'checkbox', checkbox: false }), false)
})

test('extractPropertyValue: url / email / phone_number', () => {
	assert.equal(extractPropertyValue({ type: 'url', url: 'https://x.dev' }), 'https://x.dev')
	assert.equal(extractPropertyValue({ type: 'url', url: null }), '')
	assert.equal(extractPropertyValue({ type: 'email', email: 'a@b.c' }), 'a@b.c')
	assert.equal(extractPropertyValue({ type: 'phone_number', phone_number: '600111222' }), '600111222')
})

test('extractPropertyValue: relation devuelve el array crudo (o [] si null)', () => {
	const rel = [{ id: 'abc' }, { id: 'def' }]
	assert.deepEqual(extractPropertyValue({ type: 'relation', relation: rel }), rel)
	assert.deepEqual(extractPropertyValue({ type: 'relation', relation: null }), [])
})

test('extractPropertyValue: rollup array lee el primer item por tipo', () => {
	assert.equal(extractPropertyValue({
		type: 'rollup',
		rollup: { type: 'array', array: [{ type: 'title', title: [{ plain_text: 'Obra Y' }] }] }
	}), 'Obra Y')
	assert.equal(extractPropertyValue({
		type: 'rollup',
		rollup: { type: 'array', array: [{ type: 'rich_text', rich_text: [{ plain_text: 'texto' }] }] }
	}), 'texto')
	assert.equal(extractPropertyValue({
		type: 'rollup',
		rollup: { type: 'array', array: [{ type: 'date', date: { start: '2026-01-02' } }] }
	}), '2026-01-02')
	assert.equal(extractPropertyValue({
		type: 'rollup',
		rollup: { type: 'array', array: [{ type: 'select', select: { name: 'Rojo' } }] }
	}), 'Rojo')
	assert.equal(extractPropertyValue({
		type: 'rollup',
		rollup: { type: 'array', array: [{ type: 'number', number: 42 }] }
	}), 42)
	// Array vacío o tipo no contemplado → ''
	assert.equal(extractPropertyValue({ type: 'rollup', rollup: { type: 'array', array: [] } }), '')
	assert.equal(extractPropertyValue({
		type: 'rollup',
		rollup: { type: 'array', array: [{ type: 'checkbox', checkbox: true }] }
	}), '')
})

test('extractPropertyValue: formula — string gana a number; boolean false cae a "" (quirk documentado)', () => {
	assert.equal(extractPropertyValue({ type: 'formula', formula: { string: 'hola' } }), 'hola')
	assert.equal(extractPropertyValue({ type: 'formula', formula: { number: 7 } }), 7)
	assert.equal(extractPropertyValue({ type: 'formula', formula: { boolean: true } }), true)
	// `string || number || boolean || ''`: false y 0 se pierden — es el contrato vigente.
	assert.equal(extractPropertyValue({ type: 'formula', formula: { boolean: false } }), '')
	assert.equal(extractPropertyValue({ type: 'formula', formula: { number: 0 } }), '')
})

test('extractPropertyValue: unique_id concatena prefix+number', () => {
	assert.equal(extractPropertyValue({ type: 'unique_id', unique_id: { prefix: 'COP-', number: 12 } }), 'COP-12')
})

test('extractPropertyValue: created_time / last_edited_time / files', () => {
	assert.equal(extractPropertyValue({ type: 'created_time', created_time: '2026-08-01T00:00:00Z' }), '2026-08-01T00:00:00Z')
	assert.equal(extractPropertyValue({ type: 'last_edited_time', last_edited_time: '2026-08-02T00:00:00Z' }), '2026-08-02T00:00:00Z')
	const files = [{ name: 'f.pdf' }]
	assert.deepEqual(extractPropertyValue({ type: 'files', files }), files)
})

test('extractPropertyValue: tipo desconocido devuelve "[tipo]" (marcador visible, no crash)', () => {
	assert.equal(extractPropertyValue({ type: 'people', people: [] }), '[people]')
})

// ─── buildEstadoUpdatePayload ────────────────────────────────────────────────

test('buildEstadoUpdatePayload: status (default), select y multi_select', () => {
	assert.deepEqual(buildEstadoUpdatePayload({ type: 'status' }, 'Enviado'), { status: { name: 'Enviado' } })
	assert.deepEqual(buildEstadoUpdatePayload({ type: 'select' }, 'Enviado'), { select: { name: 'Enviado' } })
	assert.deepEqual(buildEstadoUpdatePayload({ type: 'multi_select' }, 'Enviado'), { multi_select: [{ name: 'Enviado' }] })
	// Propiedad desconocida o ausente → status (default)
	assert.deepEqual(buildEstadoUpdatePayload(undefined, 'Enviado'), { status: { name: 'Enviado' } })
})

test('buildEstadoUpdatePayload: recorta espacios y rechaza estado vacío', () => {
	assert.deepEqual(buildEstadoUpdatePayload({ type: 'status' }, '  Firmado  '), { status: { name: 'Firmado' } })
	assert.throws(() => buildEstadoUpdatePayload({ type: 'status' }, ''), /inválido/)
	assert.throws(() => buildEstadoUpdatePayload({ type: 'status' }, '   '), /inválido/)
	assert.throws(() => buildEstadoUpdatePayload({ type: 'status' }, null), /inválido/)
})

// ─── Mappers ─────────────────────────────────────────────────────────────────

const titulo = (texto) => ({ type: 'title', title: [{ plain_text: texto }] })
const texto = (t) => ({ type: 'rich_text', rich_text: [{ plain_text: t }] })
const sel = (name) => ({ type: 'select', select: { name } })
const estado = (name) => ({ type: 'status', status: { name } })

test('mapObra: forma exacta del DTO', () => {
	const dto = mapObra({
		id: 'obra-1',
		properties: {
			'Obra - Codigo': titulo('OB-001 Lentiscos'),
			'Provincia': sel('Las Palmas'),
			'Estado': estado('Activa')
		}
	})
	assert.deepEqual(dto, { id: 'obra-1', nombre: 'OB-001 Lentiscos', provincia: 'Las Palmas', estado: 'Activa' })
})

test('mapJefeObra: lee " Email" con espacio inicial (así se llama en Notion)', () => {
	const dto = mapJefeObra({
		id: 'jefe-1',
		properties: {
			'Persona Autorizada': titulo('Efrén P.'),
			' Email': { type: 'email', email: 'efren@copuno.com' }
		}
	})
	assert.deepEqual(dto, { id: 'jefe-1', nombre: 'Efrén P.', email: 'efren@copuno.com' })
})

test('mapFirmanteAutorizado: rol vacío cae a "Otros"', () => {
	const base = {
		id: 'f-1',
		properties: {
			'Persona Autorizada': titulo('Firmante'),
			' Email': { type: 'email', email: 'x@y.z' },
			'Rol': sel('Encargado')
		}
	}
	assert.equal(mapFirmanteAutorizado(base).rol, 'Encargado')
	const sinRol = { ...base, properties: { ...base.properties, 'Rol': { type: 'select', select: null } } }
	assert.equal(mapFirmanteAutorizado(sinRol).rol, 'Otros')
})

test('mapEmpleado: el nombre se lee por TIPO title, inmune a renombres de la propiedad (I9)', () => {
	// La propiedad título se llama '' (renombre real que tumbó producción en jul-2026).
	const dto = mapEmpleado({
		id: 'emp-1',
		properties: {
			'': titulo('María García'),
			'ID COPUNO': { type: 'number', number: 123 },
			'Categoría': sel('Oficial 1ª'),
			'Provincia': sel('Las Palmas'),
			'Localidad': sel('Telde'),
			'Teléfono': { type: 'phone_number', phone_number: '600' },
			'DNI': texto('00000000A'),
			'Estado': estado('Alta'),
			'Delegado': sel('Sur')
		}
	})
	assert.equal(dto.nombre, 'María García')
	assert.equal(dto.idCopuno, 123)
	assert.equal(dto.categoria, 'Oficial 1ª')
})

test('mapEmpleado: sin ID COPUNO devuelve null (no 0 — distingue "sin migrar" de "id 0")', () => {
	const dto = mapEmpleado({ id: 'emp-2', properties: { 'Nombre Completo': titulo('Pepe') } })
	assert.equal(dto.idCopuno, null)
	assert.equal(dto.nombre, 'Pepe')
})

test('mapParte: propiedades con espacio final ("Horas Oficial 2ª ", "AUX Cliente - texto- ", "Vehiculos ")', () => {
	const dto = mapParte({
		id: 'parte-1',
		properties: {
			'Nombre': titulo('Parte 300'),
			'Fecha': { type: 'date', date: { start: '2026-08-24' } },
			'Estado': estado('Borrador'),
			'AUX Obra': { type: 'rollup', rollup: { type: 'array', array: [{ type: 'title', title: [{ plain_text: 'OB-001' }] }] } },
			'AUX Cliente - texto- ': texto('COPUNO SL'),
			'Horas Oficial 2ª ': { type: 'number', number: 4 },
			'Vehiculos': texto('7072KLC'),
			'Vehiculos ': { type: 'relation', relation: [{ id: 'veh-1' }, { id: 'veh-2' }] }
		}
	})
	assert.equal(dto.nombre, 'Parte 300')
	assert.equal(dto.obra, 'OB-001')
	assert.equal(dto.cliente, 'COPUNO SL')
	assert.equal(dto.horasOficial2, 4)
	assert.equal(dto.vehiculos, '7072KLC')
	assert.deepEqual(dto.vehiculosIds, ['veh-1', 'veh-2'])
})

test('mapParte: vínculo de rectificación — ausente y presente', () => {
	const sinRect = mapParte({ id: 'p-1', properties: { 'Nombre': titulo('Normal') } })
	assert.equal(sinRect.rectificaAId, null)
	assert.deepEqual(sinRect.rectificadoPorIds, [])
	assert.equal(sinRect.esRectificativo, false)

	const conRect = mapParte({
		id: 'p-2',
		properties: {
			'Nombre': titulo('Rectificativo'),
			'Rectifica a ': { type: 'relation', relation: [{ id: 'p-1' }] },
			'Rectificado por ': { type: 'relation', relation: [{ id: 'p-3' }, { id: 'p-4' }] }
		}
	})
	assert.equal(conRect.rectificaAId, 'p-1')
	assert.deepEqual(conRect.rectificadoPorIds, ['p-3', 'p-4'])
	assert.equal(conRect.esRectificativo, true)
})

test('mapDetalle: forma del DTO con relación de empleado cruda', () => {
	const dto = mapDetalle({
		id: 'det-1',
		properties: {
			'Empleados': { type: 'relation', relation: [{ id: 'emp-1' }] },
			'Aux Empleado': { type: 'rollup', rollup: { type: 'array', array: [{ type: 'title', title: [{ plain_text: 'María' }] }] } },
			'AUX_Categoria': { type: 'rollup', rollup: { type: 'array', array: [{ type: 'select', select: { name: 'Oficial 1ª' } }] } },
			'Cantidad Horas': { type: 'number', number: 8 },
			'Fecha': { type: 'date', date: { start: '2026-08-24' } },
			'Detalle': titulo('Detalle Horas')
		}
	})
	assert.deepEqual(dto.empleadoId, [{ id: 'emp-1' }])
	assert.equal(dto.empleadoNombre, 'María')
	assert.equal(dto.categoria, 'Oficial 1ª')
	assert.equal(dto.horas, 8)
})

// ─── enLotes ─────────────────────────────────────────────────────────────────

test('enLotes: procesa todo, conserva el orden y envuelve resultados en {ok, value}', async () => {
	const vistos = []
	const res = await enLotes([1, 2, 3, 4, 5], 2, async (n) => {
		vistos.push(n)
		return n * 10
	})
	assert.deepEqual(res.map(r => r.value), [10, 20, 30, 40, 50])
	assert.ok(res.every(r => r.ok))
	assert.deepEqual(vistos.sort((a, b) => a - b), [1, 2, 3, 4, 5])
})

test('enLotes: un fallo NO corta las tandas posteriores y se reporta con {ok:false, item, error}', async () => {
	const res = await enLotes([1, 2, 3], 1, async (n) => {
		if (n === 2) throw new Error('boom')
		return n
	})
	assert.equal(res.length, 3)
	assert.deepEqual(res.map(r => r.ok), [true, false, true])
	assert.equal(res[1].item, 2)
	assert.equal(res[1].error.message, 'boom')
})

test('enLotes: respeta la concurrencia máxima por tanda', async () => {
	let enVuelo = 0
	let maxEnVuelo = 0
	await enLotes([1, 2, 3, 4, 5, 6], 3, async () => {
		enVuelo++
		maxEnVuelo = Math.max(maxEnVuelo, enVuelo)
		await new Promise(r => setTimeout(r, 10))
		enVuelo--
	})
	assert.ok(maxEnVuelo <= 3, `en vuelo llegó a ${maxEnVuelo}, máximo permitido 3`)
})

// ─── conReintento429 ─────────────────────────────────────────────────────────

test('conReintento429: éxito a la primera no reintenta', async () => {
	let llamadas = 0
	const res = await conReintento429(async () => { llamadas++; return 'ok' })
	assert.equal(res, 'ok')
	assert.equal(llamadas, 1)
})

test('conReintento429: un 429 reintenta UNA vez y devuelve el segundo resultado', async () => {
	let llamadas = 0
	const res = await conReintento429(async () => {
		llamadas++
		if (llamadas === 1) {
			const err = new Error('rate limited')
			err.status = 429
			err.retryAfter = 0.001 // 1 ms — el test no espera el Retry-After real
			throw err
		}
		return 'ok tras retry'
	})
	assert.equal(res, 'ok tras retry')
	assert.equal(llamadas, 2)
})

test('conReintento429: un segundo 429 se propaga (reintento único, no bucle)', async () => {
	let llamadas = 0
	await assert.rejects(conReintento429(async () => {
		llamadas++
		const err = new Error('rate limited')
		err.status = 429
		err.retryAfter = 0.001
		throw err
	}), /rate limited/)
	assert.equal(llamadas, 2)
})

test('conReintento429: errores que no son 429 se propagan sin reintentar', async () => {
	let llamadas = 0
	await assert.rejects(conReintento429(async () => {
		llamadas++
		const err = new Error('server error')
		err.status = 500
		throw err
	}), /server error/)
	assert.equal(llamadas, 1)
})
