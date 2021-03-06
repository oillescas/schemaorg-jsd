const fs   = require('fs')
const path = require('path')
const url  = require('url')
const util = require('util')

const gulp  = require('gulp')
const jsdoc = require('gulp-jsdoc3')
const Ajv   = require('ajv')

const createDir = require('./lib/createDir.js')

const sdo_jsd = require('./index.js')


gulp.task('validate', async function () {
  const [META_SCHEMATA, SCHEMATA] = await Promise.all([sdo_jsd.getMetaSchemata(), sdo_jsd.getSchemata()])
  new Ajv().addMetaSchema(META_SCHEMATA).addSchema(SCHEMATA)
})

gulp.task('test', async function () {
  return Promise.all((await util.promisify(fs.readdir)('./test')).map(async function (file) {
    let filepath = path.resolve(__dirname, './test/', file)
    let returned;
    try {
      returned = await sdo_jsd.sdoValidate(filepath)
      console.log(`The example ${file} is valid.`)
    } catch (e) {
      console.error(`The example ${file} failed!`, e.details || e)
    }
    return returned
  }))
})

gulp.task('docs:jsonld', ['validate'], async function () {
  // ++++ LOCAL VARIABLES ++++
  const SCHEMATA = (await sdo_jsd.getSchemata())
    .filter((jsd) => path.parse(new url.URL(jsd['$id']).pathname).name !== 'json-ld') // TODO: reference json-ld.jsd externally
  let label     = (jsd) => path.parse(new url.URL(jsd.title).pathname).name
  let comment   = (jsd) => jsd.description
  let supertype = (jsd) => (label(jsd) !== 'Thing') ? path.parse(jsd.allOf[0].$ref).name : null

  // ++++ MAP TO JSON-LD ++++
  let datatypes = SCHEMATA.filter((jsd) => jsd.$schema === 'http://json-schema.org/draft-07/schema#').map((jsd) => ({
    '@type'        : 'rdfs:Datatype',
    '@id'          : `sdo:${label(jsd)}`,
    'rdfs:label'   : label(jsd),
    'rdfs:comment' : comment(jsd),
  }))
  let classes = SCHEMATA.filter((jsd) => jsd.$schema === 'https://chharvey.github.io/schemaorg-jsd/meta/type.jsd#').map((jsd) => ({
    '@type'           : 'rdfs:Class',
    '@id'             : `sdo:${label(jsd)}`,
    'rdfs:label'      : label(jsd),
    'rdfs:comment'    : comment(jsd),
    'rdfs:subClassOf' : (supertype(jsd)) ? { '@id': `sdo:${supertype(jsd)}` } : null,
    'superClassOf'    : [], // non-normative
    'rdfs:member'     : Object.entries(jsd.allOf[1].properties).map(function (entry) {
      let [key, value] = entry
      let memberjsd = SCHEMATA.find((j) => j.title===`http://schema.org/${key}`) || null
      if (memberjsd) return { '@id': `sdo:${key}` }
      else throw new ReferenceError(`No corresponding jsd file was found for member subschema \`${label(jsd)}#${key}\`.`)
    }),
    'valueOf': [], // non-normative
  }))
  let properties = SCHEMATA.filter((jsd) => jsd.$schema === 'https://chharvey.github.io/schemaorg-jsd/meta/member.jsd#').map((jsd) => ({
    '@type'        : 'rdf:Property',
    '@id'          : `sdo:${label(jsd)}`,
    'rdfs:label'   : label(jsd),
    'rdfs:comment' : comment(jsd),
    'rdfs:subPropertyOf': (jsd.allOf[0] !== true) ? { '@id': `sdo:${supertype(jsd).split('.')[0]}` } : null,
    'superPropertyOf': [], // non-normative
    'rdfs:domain'  : [], // non-normative
    '$rangeArray'  : jsd.allOf[1].anyOf.length >= 2, // non-standard
    'rdfs:range'   : (function (propertyschema) {
      const sdo_type = {
        'boolean': 'Boolean',
        'integer': 'Integer',
        'number' : 'Number' ,
        'string' : 'Text'   ,
      }
      // NOTE Cannot use `Array#map` here because there is not a 1-to-1 correspondance
      // between the schemata in `anyOf` and the pushed jsonld objects.
      // (Namely, if the jsd `"type"` property is an array, e.g. `["number", "string"]`.)
      const returned = []
      propertyschema.definitions['ExpectedType'].anyOf.forEach(function (schema) {
        if (schema.$ref) returned.push({ '@id': `sdo:${path.parse(schema.$ref).name}` })
        else {
          if (Array.isArray(schema.type)) returned.push(...schema.type.map((t) => ({ '@id': `sdo:${sdo_type[t]}` })))
          else returned.push({ '@id': `sdo:${sdo_type[schema.type]}` })
        }
      })
      return returned
    })(jsd),
  }))

  // ++++ PROCESS NON-NORMATIVE SCHEMA DATA ++++
  /*
   * Process non-normative subclasses.
   * Subclasses are non-normative because this information can be processed from each class’s superclass.
   */
  classes.forEach(function (jsonld) {
    let superclass = jsonld['rdfs:subClassOf']
    let referenced = (superclass) ? classes.find((c) => c['@id'] === superclass['@id']) || null : null
    if (referenced) {
      referenced['superClassOf'].push({ '@id': jsonld['@id'] })
    }
  })
  /*
   * Process non-normative subproperties.
   * Subproperties are non-normative because this information can be processed from each property’s superproperty.
   */
  properties.forEach(function (jsonld) {
    let superproperty = jsonld['rdfs:subPropertyOf']
    let referenced = (superproperty) ? properties.find((p) => p['@id'] === superproperty['@id']) || null : null
    if (referenced) {
      referenced['superPropertyOf'].push({ '@id': jsonld['@id'] })
    }
  })
  /*
   * Process non-normative `rdfs:domain`.
   * A property’s `rdfs:domain` is non-normative because this information can be processed from each type’s members.
   */
  classes.forEach(function (jsonld) {
    jsonld['rdfs:member'].forEach(function (property) {
      let referenced = properties.find((m) => m['@id'] === property['@id']) || null
      if (referenced) {
        referenced['rdfs:domain'].push({ '@id': jsonld['@id'] })
      }
    })
  })
  /*
   * Process non-normative `valueOf`.
   * A class’s `valueOf` is non-normative because this information can be processed from each property’s `rdfs:range`.
   */
  properties.forEach(function (jsonld) {
    jsonld['rdfs:range'].forEach(function (class_) {
      let referenced = classes.find((c) => c['@id'] === class_['@id']) || null
      if (referenced) {
        referenced['valueOf'].push({ '@id': jsonld['@id'] })
      }
    })
  })

  // ++++ DEFINE THE CONTENT TO WRITE ++++
  let contents = JSON.stringify({
    "@context": {
      "sdo" : "http://schema.org/",
      "rdf" : "https://www.w3.org/1999/02/22-rdf-syntax-ns#",
      "rdfs": "http://www.w3.org/2000/01/rdf-schema#",
      "superClassOf": { "@reverse": "rdfs:subClassOf" },
      "superPropertyOf": { "@reverse": "rdfs:subPropertyOf" },
      "valueOf"     : { "@reverse": "rdfs:range" }
    },
    '@graph': [
      ...datatypes,
      ...classes,
      ...properties,
    ],
  })

  // ++++ WRITE TO FILE ++++
  await createDir('./docs/build/')
  await util.promisify(fs.writeFile)('./docs/build/schemaorg.jsonld', contents, 'utf8')
})

gulp.task('docs:typedef', ['docs:jsonld'], async function () {
  const JSONLD = JSON.parse(await util.promisify(fs.readFile)('./docs/build/schemaorg.jsonld', 'utf8'))['@graph']

  let datatypes = JSONLD.filter((jsonld) => jsonld['@type'] === 'rdfs:Datatype').map((jsonld) => `
    /**
     * @summary ${jsonld['rdfs:comment']}
     * @see http://schema.org/${jsonld['rdfs:label']}
     * @typedef {${({
       'Boolean'  : 'boolean',
       'Date'     : 'string',
       'DateTime' : 'string',
       'Integer'  : 'number',
       'Number'   : 'number',
       'Text'     : 'string',
       'Time'     : 'string',
       'URL'      : 'string',
     })[jsonld['rdfs:label']]}} ${jsonld['rdfs:label']}
     */
  `)
  let classes = JSONLD.filter((jsonld) => jsonld['@type'] === 'rdfs:Class').map((jsonld) => `
    /**
     * @summary ${jsonld['rdfs:comment']}
     * ${(jsonld['superClassOf'].length || jsonld['valueOf'].length) ? '@description' : ''}
     * ${(jsonld['superClassOf'].length) ? `*(Non-Normative):* Known subtypes:
    ${jsonld['superClassOf'].map((obj) => ` * - {@link ${obj['@id'].split(':')[1]}}`).join('\n')}` : ''}
     *
     * ${(jsonld['valueOf'].length) ? `*(Non-Normative):* May appear as values of:
    ${jsonld['valueOf'].map((obj) => ` * - {@link ${obj['@id'].split(':')[1]}}`).join('\n')}` : ''}
     *
     * @see http://schema.org/${jsonld['rdfs:label']}
     * @typedef {${(jsonld['rdfs:subClassOf']) ? jsonld['rdfs:subClassOf']['@id'].split(':')[1] : '!Object'}} ${jsonld['rdfs:label']}
    ${jsonld['rdfs:member'].map(function (propertyld) {
      let referenced = JSONLD.find((m) => m['@id'] === propertyld['@id']) || null
      if (!referenced) throw new ReferenceError(`{ "@id": "${propertyld['@id']}" } not found.`)
      return ` * @property {${referenced['rdfs:label']}=} ${referenced['rdfs:label']} ${referenced['rdfs:comment']}`
    }).join('\n')}
     */
  `)
  let properties = JSONLD.filter((jsonld) => jsonld['@type'] === 'rdf:Property').map((jsonld) => `
    /**
     * @summary ${jsonld['rdfs:comment']}
     * ${(jsonld['rdfs:subPropertyOf'] || jsonld['superPropertyOf'].length || jsonld['rdfs:domain'].length) ? '@description' : ''}
     * ${(jsonld['rdfs:subPropertyOf']) ? `Extends:
     * - {@link ${jsonld['rdfs:subPropertyOf']['@id'].split(':')[1]}}` : ''}
     *
     * ${(jsonld['superPropertyOf'].length) ? `*(Non-Normative):* Known subproperties:
     ${jsonld['superPropertyOf'].map((obj) => ` * - {@link ${obj['@id'].split(':')[1]}}`).join('\n')}` : ''}
     *
     * ${(jsonld['rdfs:domain'].length) ? `*(Non-Normative):* Property of:
    ${jsonld['rdfs:domain'].map((obj) => ` * - {@link ${obj['@id'].split(':')[1]}}`).join('\n')}` : ''}
     *
     * @see http://schema.org/${jsonld['rdfs:label']}
     * @typedef {${(function (propertyld) {
       let union = `(${propertyld['rdfs:range'].map((cls) => cls['@id'].split(':')[1]).join('|')})`
       return (propertyld['$rangeArray']) ? `(${union}|Array<${union}>)` : union
     })(jsonld)}} ${jsonld['rdfs:label']}
     */
  `)

    let contents = [
      ...datatypes,
      ...classes,
      ...properties,
    ].join('')

  await util.promisify(fs.writeFile)('./docs/build/typedef.js', contents, 'utf8')
})

// HOW-TO: https://github.com/mlucool/gulp-jsdoc3#usage
gulp.task('docs:api', ['docs:typedef'], function () {
  return gulp.src(['./README.md', './index.js', './docs/build/typedef.js'], {read:false})
    .pipe(jsdoc(require('./jsdoc.config.json')))
})

gulp.task('build', ['validate', 'test', 'docs:api'])
