'use strict';
const writer = require('../../utils/writer.js')
const dbUtils = require('./utils')

const _this = this

/**
Generalized queries for package(s).
**/
exports.queryPackages = async function (inProjection = [], inPredicates = {}, elevate = false, userObject) {
  try {
    let context
    if (userObject.accessLevel === 3 || elevate) {
      context = dbUtils.CONTEXT_ALL
    } else if (userObject.accessLevel === 2) {
      context = dbUtils.CONTEXT_DEPT
    } else {
      context = dbUtils.CONTEXT_USER
    }

    let columns = [
      'p.packageId',
      'p.name',
      'p.emassId',
      'p.pocName',
      'p.pocEmail',
      'p.pocPhone',
      'p.reqRar'
    ]
    let joins = [
      'package p',
      'left join asset_package_map ap on p.packageId=ap.packageId',
      'left join asset a on ap.assetId = a.assetId',
      'left join stig_asset_map sa on a.assetId = sa.assetId',
      'left join department d on a.deptId = d.deptId'
    ]

    // PROJECTIONS
    if (inProjection.includes('assets')) {
      columns.push(`cast(
        concat('[', 
          coalesce (
            group_concat(distinct 
              case when a.assetId is not null then 
                json_object(
                  'assetId', a.assetId, 
                  'name', a.name, 
                  'dept', json_object (
                    'deptId', d.deptId,
                    'name', d.name
                  )
                )
              else null end 
            order by a.name),
            ''),
        ']')
      as json) as "assets"`)
    }
    if (inProjection.includes('stigs')) {
      joins.push('left join current_rev cr on sa.benchmarkId=cr.benchmarkId')
      joins.push('left join stig st on cr.benchmarkId=st.benchmarkId')
      columns.push(`cast(
        concat('[', 
          coalesce (
            group_concat(distinct 
              case when cr.benchmarkId is not null then 
                json_object(
                  'benchmarkId', cr.benchmarkId, 
                  'lastRevisionStr', concat('V', cr.version, 'R', cr.release), 
                  'lastRevisionDate', cr.benchmarkDateSql,
                  'title', st.title)
              else null end 
        order by a.name),
            ''),
        ']')
      as json) as "stigs"`)
    }

    // PREDICATES
    let predicates = {
      statements: [],
      binds: []
    }
    if (inPredicates.packageId) {
      predicates.statements.push('p.packageId = ?')
      predicates.binds.push( inPredicates.packageId )
    }
    if (context == dbUtils.CONTEXT_DEPT) {
      predicates.statements.push('a.deptId = ?')
      predicates.binds.push( userObject.dept.deptId )
    } 
    else if (context == dbUtils.CONTEXT_USER) {
      joins.push('left join user_stig_asset_map usa on sa.saId = usa.saId')
      predicates.statements.push('usa.userId = ?')
      predicates.binds.push( userObject.userId )

    }

    // CONSTRUCT MAIN QUERY
    let sql = 'SELECT '
    sql+= columns.join(",\n")
    sql += ' FROM '
    sql+= joins.join(" \n")
    if (predicates.statements.length > 0) {
      sql += "\nWHERE " + predicates.statements.join(" and ")
    }
    sql += ' group by p.packageId, p.name, p.emassid, p.pocname, p.pocemail, p.pocphone, p.reqrar'
    sql += ' order by p.name'
    
    let [rows] = await dbUtils.pool.query(sql, predicates.binds)
    return (rows)
  }
  catch (err) {
    throw err
  }
}

exports.addOrUpdatePackage = async function(writeAction, packageId, body, projection, userObject) {
  // CREATE: packageId will be null
  // REPLACE/UPDATE: packageId is not null
  let connection // available to try, catch, and finally blocks
  try {
    // Extract non-scalar properties to separate variables
    let { assetIds, ...packageFields } = body
    
    // Convert boolean scalar values to database values (true=1 or false=0)
    if ('reqRar' in packageFields) {
      packageFields.reqRar = packageFields.reqRar ? 1 : 0
    }
  
    // Connect to MySQL
    connection = await dbUtils.pool.getConnection()
    connection.config.namedPlaceholders = true
    await connection.query('START TRANSACTION');

    // Process scalar properties
    let binds =  { ...packageFields}
    if (writeAction === dbUtils.WRITE_ACTION.CREATE) {
      // INSERT into packages
      let sqlInsert =
      `INSERT INTO
          package
          (name, emassId, pocName, pocEmail, pocPhone, reqRar)
        VALUES
          (:name, :emassId, :pocName, :pocEmail, :pocPhone, :reqRar)`
      let [rows] = await connection.execute(sqlInsert, binds)
      packageId = rows.insertId
    }
    else if (writeAction === dbUtils.WRITE_ACTION.UPDATE || writeAction === dbUtils.WRITE_ACTION.REPLACE) {
      if (Object.keys(binds).length > 0) {
        // UPDATE into packages
        let sqlUpdate =
        `UPDATE
            package
          SET
            ?
          WHERE
            packageId = ?`
        await connection.query(sqlUpdate, [packageFields, packageId])
      }
    }
    else {
      throw('Invalid writeAction')
    }

    // Process assetIds
    if (assetIds && writeAction !== dbUtils.WRITE_ACTION.CREATE) {
      // DELETE from asset_package_map
      let sqlDeleteAssets = 'DELETE FROM asset_package_map where packageId = ?'
      await connection.execute(sqlDeleteAssets, [packageId])
    }
    if (assetIds.length > 0) {
      // INSERT into asset_package_map
      let sqlInsertAssets = `
        INSERT INTO 
          asset_package_map (packageId, assetId)
        VALUES
          ?`      
      let binds = assetIds.map(i => [packageId, i])
      await connection.query(sqlInsertAssets, [binds])
    }

    // Commit the changes
    await connection.commit()
  }
  catch (err) {
    await connection.rollback()
    throw err
  }
  finally {
    if (typeof connection !== 'undefined') {
      await connection.release()
    }
  }

  try {
    let row = await _this.getPackage(packageId, projection, true, userObject)
    return row
  }
  catch (err) {
    throw ( writer.respondWithCode ( 500, {message: err.message,stack: err.stack} ) )
  }
}

/**
 * Create a Package
 *
 * body PackageAssign  (optional)
 * returns List
 **/
exports.createPackage = async function(body, projection, userObject) {
  try {
    let row = await _this.addOrUpdatePackage(dbUtils.WRITE_ACTION.CREATE, null, body, projection, userObject)
    return (row)
  }
  catch (err) {
    throw ( writer.respondWithCode ( 500, {message: err.message,stack: err.stack} ) )
  }
}


/**
 * Delete a Package
 *
 * packageId Integer A path parameter that indentifies a Package
 * returns PackageInfo
 **/
exports.deletePackage = async function(packageId, projection, elevate, userObject) {
  try {
    let row = await _this.queryPackages(projection, { packageId: packageId }, elevate, userObject)
    let sqlDelete = `DELETE FROM package where packageId = ?`
    await dbUtils.pool.query(sqlDelete, [packageId])
    return (row[0])
  }
  catch (err) {
    throw ( writer.respondWithCode ( 500, {message: err.message,stack: err.stack} ) )
  }
}


/**
 * Return the Checklist for the supplied Package and STIG 
 *
 * packageId Integer A path parameter that indentifies a Package
 * benchmarkId String A path parameter that indentifies a STIG
 * revisionStr String A path parameter that indentifies a STIG revision [ V{version_num}R{release_num} | 'latest' ]
 * returns PackageChecklist
 **/
exports.getChecklistByPackageStig = async function (packageId, benchmarkId, revisionStr, userObject ) {
  let connection
  try {
    let joins = [
      'asset_package_map ap',
      'left join stig_asset_map sa on ap.assetId=sa.assetId',
      'left join current_rev rev on sa.benchmarkId=rev.benchmarkId',
      'left join rev_group_map rg on rev.revId=rg.revId',
      'left join `group` g on rg.groupId=g.groupId',
      'left join rev_group_rule_map rgr on rg.rgId=rgr.rgId',
      'left join rule rules on rgr.ruleId=rules.ruleId',
      'left join (select distinct ruleId from rule_oval_map) scap on rgr.ruleId=scap.ruleId',
      'left join review r on (rgr.ruleId=r.ruleId and sa.assetId=r.assetId)'
    ]

    let predicates = {
      statements: [
        'ap.packageId = :packageId',
        'rev.benchmarkId = :benchmarkId'
      ],
      binds: {
        packageId: packageId,
        benchmarkId: benchmarkId
      }
    }

    // Non-current revision
    if (revisionStr !== 'latest') {
      joins.splice(2, 1, 'left join revision rev on sa.benchmarkId=rev.benchmarkId')
      let results = /V(\d+)R(\d+(\.\d+)?)/.exec(revisionStr)
      predicates.statements.push('rev.version = :version')
      predicates.statements.push('rev.release = :release')
      predicates.binds.version = results[1]
      predicates.binds.release = results[2]
    }

    // Non-staff access control
    if (userObject.accessLevel === 2) {
      predicates.statements.push('ap.assetId in (select assetId from asset where deptId=:deptId)')
      predicates.binds.deptId = userObject.dept.deptId
    } 
    else if (userObject.accessLevel === 1) {
      predicates.statements.push(`ap.assetId in (
        select
            sa.assetId
        from
            user_stig_asset_map usa 
            left join stig_asset_map sa on usa.saId=sa.saId
        where
            usa.userId=:userId)`)
      predicates.binds.userId = userObject.userId
    }
  
    let sql = `
      select
        r.ruleId
        ,r.ruleTitle
        ,r.groupId
        ,r.groupTitle
        ,r.severity
        ,r.autoCheckAvailable
        ,sum(CASE WHEN r.resultId = 4 THEN 1 ELSE 0 END) as "oCnt"
        ,sum(CASE WHEN r.resultId = 3 THEN 1 ELSE 0 END) as "nfCnt"
        ,sum(CASE WHEN r.resultId = 2 THEN 1 ELSE 0 END) as "naCnt"
        ,sum(CASE WHEN r.resultId is null THEN 1 ELSE 0 END) as "nrCnt"
        ,sum(CASE WHEN r.statusId = 3 THEN 1 ELSE 0 END) as "approveCnt"
        ,sum(CASE WHEN r.statusId = 2 THEN 1 ELSE 0 END) as "rejectCnt"
        ,sum(CASE WHEN r.statusId = 1 THEN 1 ELSE 0 END) as "readyCnt"
      from (
        select
          ap.assetId
          ,rgr.ruleId
          ,rules.title as ruleTitle
          ,rules.severity
          ,rg.groupId
          ,g.title as groupTitle
          ,r.resultId
          ,r.statusId
          ,CASE WHEN scap.ruleId is null THEN 0 ELSE 1 END as "autoCheckAvailable"
        from
          ${joins.join('\n')}
        where
          ${predicates.statements.join(' and ')}
        ) r
      group by
        r.ruleId
        ,r.ruleTitle
        ,r.severity
        ,r.groupId
        ,r.groupTitle
        ,r.autoCheckAvailable
      order by
        substring(r.groupId from 3) + 0
    `
    // Send query
    connection = await dbUtils.pool.getConnection()
    connection.config.namedPlaceholders = true
    let [rows] = await connection.query(sql, predicates.binds)
    for (const row of rows) {
      row.autoCheckAvailable = row.autoCheckAvailable === 1 ? true : false
    }
    return (rows.length > 0 ? rows : null)
  }
  catch (err) {
    throw ( writer.respondWithCode ( 500, { message: err.message, stack: err.stack }))
  }
  finally {
    if (typeof connection !== 'undefined') {
      await connection.release()
    }
  }
}


/**
 * Return a Package
 *
 * packageId Integer A path parameter that indentifies a Package
 * returns PackageInfo
 **/
exports.getPackage = async function(packageId, projection, elevate, userObject) {
  try {
    let rows = await _this.queryPackages(projection, {
      packageId: packageId
    }, elevate, userObject)
  return (rows[0])
  }
  catch (err) {
    throw ( writer.respondWithCode ( 500, {message: err.message,stack: err.stack} ) )
  }
}


/**
 * Return a list of Packages accessible to the user
 *
 * returns List
 **/
exports.getPackages = async function(projection, elevate, userObject) {
  try {
    let rows = await _this.queryPackages(projection, {}, elevate, userObject)
    return (rows)
  }
  catch (err) {
    throw ( writer.respondWithCode ( 500, {message: err.message,stack: err.stack} ) )
  }
}


/**
 * Replace all properties of a Package
 *
 * body PackageAssign  (optional)
 * packageId Integer A path parameter that indentifies a Package
 * returns PackageInfo
 **/
exports.replacePackage = async function( packageId, body, projection, userObject) {
  try {
    let row = await _this.addOrUpdatePackage(dbUtils.WRITE_ACTION.REPLACE, packageId, body, projection, userObject)
    return (row)
  } 
  catch (err) {
    throw ( writer.respondWithCode ( 500, {message: err.message,stack: err.stack} ) )
  }
}


/**
 * Merge updates to a Package
 *
 * body PackageAssign  (optional)
 * packageId Integer A path parameter that indentifies a Package
 * returns PackageInfo
 **/
exports.updatePackage = async function( packageId, body, projection, userObject) {
  try {
    let row = await _this.addOrUpdatePackage(dbUtils.WRITE_ACTION.UPDATE, packageId, body, projection, userObject)
    return (row)
  } 
  catch (err) {
    throw ( writer.respondWithCode ( 500, {message: err.message,stack: err.stack} ) )
  }
}

