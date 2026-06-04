/**
 * kml-generator.js
 * Converte dados de Network Assets (CSV ou JSON) em arquivos KML
 * com polígonos de cobertura por tipo (antena, hexágono, polígono, diamante)
 * 
 * Uso no Ever i9:
 *   const { generateKML, csvToAssets } = require('./kml-generator');
 *   const assets = csvToAssets(csvString);
 *   const kmlString = generateKML(assets, 'Uberlândia');
 */

// ============================================================
// 1. PARSER DE CSV
// ============================================================
function csvToAssets(csvString) {
  const lines = csvString.trim().split('\n');
  const header = lines[0].split(',').map(h => h.trim());
  
  return lines.slice(1).map(line => {
    const cols = line.split(',').map(c => c.trim());
    return {
      id:      cols[header.indexOf('codigo')]       || cols[0],
      type:    cols[header.indexOf('tipo')]         || cols[1],
      tech:    cols[header.indexOf('tecnologia')]   || cols[2],
      lat:     parseFloat(cols[header.indexOf('latitude')]  || cols[3]),
      lng:     parseFloat(cols[header.indexOf('longitude')] || cols[4]),
      city:    cols[header.indexOf('cidade')]       || cols[5],
      bairro:  cols[header.indexOf('bairro')]       || cols[6] || '',
      status:  cols[header.indexOf('status')]       || cols[7],
      total:   parseInt(cols[header.indexOf('portas_total')]  || cols[8] || '0'),
      avail:   parseInt(cols[header.indexOf('portas_livres')] || cols[9] || '0'),
    };
  }).filter(a => !isNaN(a.lat) && !isNaN(a.lng));
}

// ============================================================
// 2. GEOMETRIA — transforma 1 ponto em forma geométrica
// ============================================================

// Desloca lat/lng por metros
function offsetMeters(lat, lng, dx, dy) {
  const newLat = lat + (dy / 111320.0);
  const newLng = lng + (dx / (111320.0 * Math.cos(lat * Math.PI / 180)));
  return [newLat, newLng];
}

// CTO = forma de antena (triângulo com haste)
function shapeAntena(lat, lng, size) {
  size = size || 100;
  return [
    offsetMeters(lat, lng, 0, size * 1.4),          // topo
    offsetMeters(lat, lng, -size * 0.5, -size * 0.3), // base esq
    offsetMeters(lat, lng, -size * 0.15, -size * 0.3),
    offsetMeters(lat, lng, -size * 0.15, -size * 1.2), // pé esq
    offsetMeters(lat, lng, size * 0.15, -size * 1.2),  // pé dir
    offsetMeters(lat, lng, size * 0.15, -size * 0.3),
    offsetMeters(lat, lng, size * 0.5, -size * 0.3),   // base dir
  ];
}

// OLT = hexágono
function shapeHexagono(lat, lng, size) {
  size = size || 200;
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const angle = Math.PI / 6 + (2 * Math.PI * i / 6);
    pts.push(offsetMeters(lat, lng, size * Math.cos(angle), size * Math.sin(angle)));
  }
  return pts;
}

// POP/Metro = polígono irregular grande
function shapePoligono(lat, lng, size) {
  size = size || 350;
  const pts = [];
  for (let i = 0; i < 8; i++) {
    const angle = (2 * Math.PI * i / 8) + (Math.random() * 0.3 - 0.15);
    const r = size * (0.8 + Math.random() * 0.4);
    pts.push(offsetMeters(lat, lng, r * Math.cos(angle), r * Math.sin(angle)));
  }
  return pts;
}

// Splitter = diamante/losango
function shapeDiamante(lat, lng, size) {
  size = size || 150;
  return [
    offsetMeters(lat, lng, 0, size),
    offsetMeters(lat, lng, size * 0.6, 0),
    offsetMeters(lat, lng, 0, -size),
    offsetMeters(lat, lng, -size * 0.6, 0),
  ];
}

// Seleciona a forma pelo tipo do asset
function getShape(asset) {
  switch (asset.type) {
    case 'OLT':      return shapeHexagono(asset.lat, asset.lng, 180);
    case 'POP':      return shapePoligono(asset.lat, asset.lng, 300);
    case 'Splitter': return shapeDiamante(asset.lat, asset.lng, 120);
    default:         return shapeAntena(asset.lat, asset.lng, 100); // CTO
  }
}

// ============================================================
// 3. ESTILOS KML (cores AABBGGRR)
// ============================================================
const STYLES = {
  cto_ativa:      { poly: '3300CC00', line: 'BB00CC00' },
  cto_lotada:     { poly: '330080DD', line: 'BB0080DD' },
  cto_planejada:  { poly: '33E95090', line: 'BBE95090' },
  olt_ativa:      { poly: '4400FFFF', line: 'FF00CCCC' },
  olt_lotada:     { poly: '440055FF', line: 'FF0055FF' },
  olt_planejada:  { poly: '44FFAA00', line: 'FFFFAA00' },
  pop_ativa:      { poly: '2200AAFF', line: 'CC00AAFF' },
  pop_lotada:     { poly: '220000FF', line: 'CC0000FF' },
  pop_planejada:  { poly: '22FF8800', line: 'CCFF8800' },
  spl_ativa:      { poly: '3300DDAA', line: 'BB00DDAA' },
  spl_lotada:     { poly: '330088DD', line: 'BB0088DD' },
  spl_planejada:  { poly: '33DD88FF', line: 'BBDD88FF' },
};

function styleId(asset) {
  const prefix = { CTO: 'cto', OLT: 'olt', POP: 'pop', Splitter: 'spl' }[asset.type] || 'cto';
  const suffix = (asset.status || 'Ativa').toLowerCase();
  return prefix + '_' + suffix;
}

// ============================================================
// 4. GERADOR KML
// ============================================================
function generateKML(assets, regionName) {
  let kml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  kml += '<kml xmlns="http://www.opengis.net/kml/2.2">\n<Document>\n';
  kml += '<name>Cobertura ' + regionName + ' - Algar Telecom</name>\n';
  kml += '<description>' + assets.length + ' assets de rede</description>\n';

  // Estilos
  for (const [id, colors] of Object.entries(STYLES)) {
    kml += '<Style id="' + id + '">';
    kml += '<PolyStyle><color>' + colors.poly + '</color><outline>1</outline></PolyStyle>';
    kml += '<LineStyle><color>' + colors.line + '</color><width>1</width></LineStyle>';
    kml += '</Style>\n';
  }

  // Placemarks (1 por asset)
  for (const a of assets) {
    const shape = getShape(a);
    // Fechar polígono (último ponto = primeiro)
    const closed = [...shape, shape[0]];
    const coords = closed.map(p => p[1].toFixed(6) + ',' + p[0].toFixed(6) + ',0').join(' ');
    
    const occ = a.total > 0 ? Math.round((a.total - a.avail) / a.total * 100) : 0;
    const sid = styleId(a);

    kml += '<Placemark>';
    kml += '<name>' + a.id + '</name>';
    kml += '<description><![CDATA[';
    kml += '<b>' + a.id + '</b><br/>';
    kml += 'Tipo: ' + a.type + '<br/>';
    kml += 'Bairro: ' + a.bairro + '<br/>';
    kml += 'Tech: ' + a.tech + '<br/>';
    kml += 'Status: ' + a.status + '<br/>';
    if (a.total > 0) {
      kml += 'Portas: ' + (a.total - a.avail) + '/' + a.total + ' (' + occ + '%)<br/>';
      kml += 'Livres: ' + a.avail;
    } else {
      kml += 'Backbone';
    }
    kml += ']]></description>';
    kml += '<styleUrl>#' + sid + '</styleUrl>';
    kml += '<Polygon><outerBoundaryIs><LinearRing>';
    kml += '<coordinates>' + coords + '</coordinates>';
    kml += '</LinearRing></outerBoundaryIs></Polygon>';
    kml += '</Placemark>\n';
  }

  kml += '</Document>\n</kml>';
  return kml;
}

// ============================================================
// 5. AGRUPADOR POR CIDADE (split em arquivos de max 1000)
// ============================================================
function generateKMLsByCity(assets, maxPerFile) {
  maxPerFile = maxPerFile || 1000;
  
  // Agrupar por cidade
  const cities = {};
  for (const a of assets) {
    const city = a.city || 'Sem Cidade';
    if (!cities[city]) cities[city] = [];
    cities[city].push(a);
  }

  const result = [];
  for (const [city, cityAssets] of Object.entries(cities)) {
    // Split se necessário (limite 1000 features)
    const chunks = [];
    for (let i = 0; i < cityAssets.length; i += maxPerFile) {
      chunks.push(cityAssets.slice(i, i + maxPerFile));
    }

    chunks.forEach((chunk, idx) => {
      const suffix = chunks.length > 1 ? ' Pt.' + (idx + 1) : '';
      const name = city + suffix;
      const slug = city.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, '-');
      const filename = 'cobertura-' + slug + (chunks.length > 1 ? '-pt' + (idx + 1) : '') + '.kml';

      result.push({
        city: city,
        filename: filename,
        assets: chunk.length,
        kml: generateKML(chunk, name),
      });
    });
  }

  return result;
}

// ============================================================
// EXPORTS
// ============================================================
module.exports = {
  csvToAssets,
  generateKML,
  generateKMLsByCity,
  getShape,
  shapeAntena,
  shapeHexagono,
  shapePoligono,
  shapeDiamante,
};
