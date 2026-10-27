const formConfigRoot = typeof window !== 'undefined' ? window : globalThis;
formConfigRoot.MESA_FORM_DEFAULTS = {
  areas: [
    { name: 'General', subareas: ['Consulta', 'Soporte', 'Seguimiento'] },
    { name: 'Proyectos', subareas: ['Planificación', 'Ejecución', 'Revisión'] },
    { name: 'Clientes', subareas: ['Atención', 'Solicitud', 'Seguimiento'] },
    { name: 'Administración', subareas: ['Gestión', 'Documentación', 'Reportes'] },
    { name: 'Operación', subareas: ['Procesos', 'Coordinación', 'Seguimiento'] },
    { name: 'Desarrollo', subareas: ['Mejora', 'Corrección', 'Mantenimiento'] }
  ],
  types: ['Solicitud', 'Bug', 'Mejora', 'Seguimiento', 'Configuración', 'Documentación'],
  priorities: ['Media', 'Alta', 'Baja'],
  theme: { mode: 'workspace', accent: '#f06a3c', hot: '#ff8051', ink: '#9c361b', initials: 'M', workspaceName: 'Mi mesa' }
};

formConfigRoot.normalizeMesaFormConfig = function normalizeMesaFormConfig(config) {
  const defaults = formConfigRoot.MESA_FORM_DEFAULTS;
  const areas = Array.isArray(config?.areas)
    ? config.areas.map((area) => {
      const name = typeof area === 'string' ? area : area?.name;
      const subareas = typeof area === 'string' ? [] : area?.subareas;
      return { name: String(name || '').trim().replace(/\s+/g, ' '), subareas: [...new Set((Array.isArray(subareas) ? subareas : []).map((item) => String(item).trim()).filter(Boolean))].slice(0, 40) };
    }).filter((area) => area.name).slice(0, 40)
    : [];
  const list = (value, fallback) => {
    const result = Array.isArray(value) ? [...new Set(value.map((item) => String(item).trim()).filter(Boolean))].slice(0, 24) : [];
    return result.length ? result : [...fallback];
  };
  return {
    areas: areas.length ? areas : JSON.parse(JSON.stringify(defaults.areas)),
    types: list(config?.types, defaults.types),
    priorities: list(config?.priorities, defaults.priorities),
    theme: {
      mode: config?.theme?.mode === 'custom' ? 'custom' : 'workspace',
      accent: /^#[0-9a-f]{6}$/i.test(config?.theme?.accent || '') ? config.theme.accent : defaults.theme.accent,
      hot: /^#[0-9a-f]{6}$/i.test(config?.theme?.hot || '') ? config.theme.hot : defaults.theme.hot,
      ink: /^#[0-9a-f]{6}$/i.test(config?.theme?.ink || '') ? config.theme.ink : defaults.theme.ink,
      initials: String(config?.theme?.initials || defaults.theme.initials).replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 3) || defaults.theme.initials,
      workspaceName: String(config?.theme?.workspaceName || defaults.theme.workspaceName).trim().slice(0, 40) || defaults.theme.workspaceName
    }
  };
};

if (typeof module !== 'undefined' && module.exports) module.exports = { MESA_FORM_DEFAULTS: formConfigRoot.MESA_FORM_DEFAULTS, normalizeMesaFormConfig: formConfigRoot.normalizeMesaFormConfig };
