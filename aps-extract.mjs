/**
 * APS DWG Metadata Extractor
 * Run: node aps-extract.mjs
 *
 * Requires environment variables:
 *   APS_CLIENT_ID
 *   APS_CLIENT_SECRET
 */

import fs from 'fs';
import path from 'path';

const APS_CLIENT_ID = process.env.APS_CLIENT_ID;
const APS_CLIENT_SECRET = process.env.APS_CLIENT_SECRET;

if (!APS_CLIENT_ID || !APS_CLIENT_SECRET) {
  console.error('❌ Set APS_CLIENT_ID and APS_CLIENT_SECRET environment variables');
  process.exit(1);
}

// Files to process (in parent Downloads folder)
const FILES = [
  'C:/Users/idans/Downloads/10156 טבלה 2 מתוקנת.dwg-2000.dwg',
  'C:/Users/idans/Downloads/4615-2חלוקה סופית לשכונת סוכנות ועדה מקומית.dwg'
];

// ===== STEP 1: Authenticate =====
async function getToken() {
  console.log('\n🔑 Step 1: Authenticating with APS...');

  const resp = await fetch('https://developer.api.autodesk.com/authentication/v2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: APS_CLIENT_ID,
      client_secret: APS_CLIENT_SECRET,
      scope: 'data:read data:write data:create bucket:read bucket:create'
    })
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Auth failed: ${resp.status} - ${err}`);
  }

  const data = await resp.json();
  console.log(`✅ Token acquired (expires in ${data.expires_in}s)`);
  return data.access_token;
}

// ===== STEP 2: Create Bucket =====
async function ensureBucket(token) {
  const bucketKey = 'susya-permit-2025021';
  console.log(`\n📦 Step 2: Creating bucket "${bucketKey}"...`);

  // Check if exists
  const checkResp = await fetch(
    `https://developer.api.autodesk.com/oss/v2/buckets/${bucketKey}/details`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );

  if (checkResp.ok) {
    console.log('✅ Bucket already exists');
    return bucketKey;
  }

  // Create
  const createResp = await fetch('https://developer.api.autodesk.com/oss/v2/buckets', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ bucketKey, policyKey: 'transient' })
  });

  if (!createResp.ok && createResp.status !== 409) {
    throw new Error(`Bucket creation failed: ${createResp.status}`);
  }

  console.log('✅ Bucket created');
  return bucketKey;
}

// ===== STEP 3: Upload File =====
async function uploadFile(token, bucketKey, filePath) {
  const fileName = path.basename(filePath);
  const safeFileName = `plan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.dwg`;

  console.log(`\n📤 Step 3: Uploading "${fileName}" as "${safeFileName}"...`);

  const fileData = fs.readFileSync(filePath);
  const fileSize = fileData.length;
  console.log(`   Size: ${(fileSize / 1024).toFixed(1)} KB`);

  // Simple upload for files < 5MB
  if (fileSize < 5 * 1024 * 1024) {
    const resp = await fetch(
      `https://developer.api.autodesk.com/oss/v2/buckets/${bucketKey}/objects/${safeFileName}`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/octet-stream',
          'Content-Length': fileSize.toString()
        },
        body: fileData
      }
    );

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Upload failed: ${resp.status} - ${err}`);
    }

    const result = await resp.json();
    const urn = Buffer.from(result.objectId).toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    console.log(`✅ Uploaded. URN: ${urn.substring(0, 40)}...`);
    return { urn, originalName: fileName, safeFileName };
  }

  // Multipart for larger files
  const PART_SIZE = 5 * 1024 * 1024;
  const numParts = Math.ceil(fileSize / PART_SIZE);
  console.log(`   Using multipart upload (${numParts} parts)...`);

  const signedResp = await fetch(
    `https://developer.api.autodesk.com/oss/v2/buckets/${bucketKey}/objects/${safeFileName}/signeds3upload?parts=${numParts}`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );

  if (!signedResp.ok) throw new Error(`Failed to get signed URLs: ${signedResp.status}`);
  const signedData = await signedResp.json();

  for (let i = 0; i < numParts; i++) {
    const start = i * PART_SIZE;
    const end = Math.min(start + PART_SIZE, fileSize);
    const partData = fileData.slice(start, end);

    const partResp = await fetch(signedData.urls[i], {
      method: 'PUT',
      headers: { 'Content-Length': partData.length.toString() },
      body: partData
    });

    if (!partResp.ok) throw new Error(`Part ${i + 1} upload failed`);
    console.log(`   Part ${i + 1}/${numParts} ✓`);
  }

  const completeResp = await fetch(
    `https://developer.api.autodesk.com/oss/v2/buckets/${bucketKey}/objects/${safeFileName}/signeds3upload`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ uploadKey: signedData.uploadKey })
    }
  );

  if (!completeResp.ok) throw new Error('Upload completion failed');
  const result = await completeResp.json();
  const urn = Buffer.from(result.objectId).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  console.log(`✅ Uploaded. URN: ${urn.substring(0, 40)}...`);
  return { urn, originalName: fileName, safeFileName };
}

// ===== STEP 4: Translate to SVF2 =====
async function translateToSVF2(token, urn) {
  console.log('\n🔄 Step 4: Submitting translation job...');

  // Delete old manifest first
  try {
    await fetch(
      `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/manifest`,
      { method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` } }
    );
  } catch (e) {}

  await new Promise(r => setTimeout(r, 2000));

  const resp = await fetch('https://developer.api.autodesk.com/modelderivative/v2/designdata/job', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'x-ads-force': 'true'
    },
    body: JSON.stringify({
      input: { urn },
      output: { formats: [{ type: 'svf2', views: ['2d', '3d'] }] }
    })
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Translation job failed: ${resp.status} - ${err}`);
  }

  console.log('✅ Translation job submitted');
  return await waitForTranslation(token, urn);
}

// ===== STEP 5: Poll Translation Status =====
async function waitForTranslation(token, urn) {
  console.log('\n⏳ Step 5: Waiting for translation...');

  const maxWait = 10 * 60 * 1000; // 10 minutes
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    const resp = await fetch(
      `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/manifest`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    const manifest = await resp.json();

    const svf2 = manifest.derivatives?.find(d => d.outputType === 'svf2');

    if (manifest.status === 'success' || svf2?.status === 'success') {
      console.log('✅ Translation complete!');
      return manifest;
    }

    if (manifest.status === 'failed') {
      const err = manifest.derivatives?.find(d => d.status === 'failed')?.messages?.[0]?.message;
      throw new Error(`Translation failed: ${err || 'Unknown error'}`);
    }

    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(`   ${manifest.progress || '0%'} (${elapsed}s)...`);
    await new Promise(r => setTimeout(r, 5000));
  }

  throw new Error('Translation timeout');
}

// ===== STEP 6: Extract Metadata =====
async function extractMetadata(token, urn) {
  console.log('\n📊 Step 6: Extracting metadata...');

  // Wait for indexing
  console.log('   Waiting 10s for metadata indexing...');
  await new Promise(r => setTimeout(r, 10000));

  // Get metadata views
  const metaResp = await fetch(
    `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/metadata`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );
  const metadata = await metaResp.json();
  console.log(`   Found ${metadata.data?.metadata?.length || 0} views`);

  const results = {
    metadata,
    views: []
  };

  for (const view of (metadata.data?.metadata || [])) {
    console.log(`\n   Processing view: ${view.name} (${view.guid})`);

    // Get object tree
    let tree = null;
    for (let i = 0; i < 10; i++) {
      const treeResp = await fetch(
        `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/metadata/${view.guid}?forceget=true`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      );

      if (treeResp.status === 200) {
        tree = await treeResp.json();
        break;
      } else if (treeResp.status === 202) {
        console.log(`   Tree processing (attempt ${i + 1})...`);
        await new Promise(r => setTimeout(r, 10000));
      } else {
        break;
      }
    }

    // Get properties
    let properties = null;
    for (let i = 0; i < 15; i++) {
      const propsResp = await fetch(
        `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/metadata/${view.guid}/properties?forceget=true`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      );

      if (propsResp.status === 200) {
        properties = await propsResp.json();
        console.log(`   ✅ Properties: ${properties.data?.collection?.length || 0} objects`);
        break;
      } else if (propsResp.status === 202) {
        console.log(`   Properties processing (attempt ${i + 1})...`);
        await new Promise(r => setTimeout(r, 15000));
      } else {
        break;
      }
    }

    results.views.push({
      guid: view.guid,
      name: view.name,
      role: view.role,
      tree,
      properties
    });
  }

  return results;
}

// ===== STEP 7: Get Thumbnail =====
async function getThumbnail(token, urn, outputFile) {
  console.log('\n🖼️ Step 7: Getting thumbnail...');

  const resp = await fetch(
    `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/thumbnail?width=400&height=400`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );

  if (resp.ok) {
    const buffer = await resp.arrayBuffer();
    fs.writeFileSync(outputFile, Buffer.from(buffer));
    console.log(`✅ Saved thumbnail: ${outputFile}`);
    return true;
  }

  console.log(`⚠️ No thumbnail available (${resp.status})`);
  return false;
}

// ===== STEP 8: Analyze and Save Results =====
function analyzeResults(data, outputPrefix) {
  console.log('\n📝 Step 8: Analyzing results...');

  const analysis = {
    summary: {
      totalObjects: 0,
      layers: {},
      texts: [],
      dimensions: [],
      blocks: [],
      extents: null
    }
  };

  for (const view of data.views) {
    const objects = view.properties?.data?.collection || [];
    analysis.summary.totalObjects += objects.length;

    for (const obj of objects) {
      const name = obj.name || '';
      const props = obj.properties || {};

      // Extract layer
      const layer = props.Layer?.['Layer'] || props['Layer'] || 'Unknown';
      analysis.summary.layers[layer] = (analysis.summary.layers[layer] || 0) + 1;

      // Extract text content
      if (/text|mtext/i.test(name) || props.Text) {
        const textContent = props.Text?.['Contents'] || props.Text?.['Text String'] || props['Text String'] || name;
        if (textContent && textContent.length > 0) {
          analysis.summary.texts.push({
            layer,
            content: textContent,
            position: props.Position || null
          });
        }
      }

      // Extract dimensions
      if (/dimension/i.test(name) || props.Dimension) {
        analysis.summary.dimensions.push({
          layer,
          value: props.Dimension?.['Measurement'] || props['Measurement'] || name,
          type: props.Dimension?.['Dimension Type'] || 'Unknown'
        });
      }

      // Extract blocks
      if (/block|insert/i.test(name)) {
        analysis.summary.blocks.push({
          name: props['Block Name'] || name,
          layer,
          attributes: props.Attributes || {}
        });
      }

      // Extract extents
      if (props.Extents || props['Bounding Box']) {
        analysis.summary.extents = props.Extents || props['Bounding Box'];
      }
    }
  }

  // Save full JSON
  const fullOutputFile = `${outputPrefix}_full.json`;
  fs.writeFileSync(fullOutputFile, JSON.stringify(data, null, 2));
  console.log(`✅ Full data saved: ${fullOutputFile}`);

  // Save analysis summary
  const analysisFile = `${outputPrefix}_analysis.json`;
  fs.writeFileSync(analysisFile, JSON.stringify(analysis, null, 2));
  console.log(`✅ Analysis saved: ${analysisFile}`);

  // Print summary
  console.log('\n📊 SUMMARY:');
  console.log(`   Total objects: ${analysis.summary.totalObjects}`);
  console.log(`   Layers: ${Object.keys(analysis.summary.layers).length}`);
  console.log(`   Texts found: ${analysis.summary.texts.length}`);
  console.log(`   Dimensions: ${analysis.summary.dimensions.length}`);
  console.log(`   Blocks: ${analysis.summary.blocks.length}`);

  // Print layers
  console.log('\n📋 LAYERS:');
  Object.entries(analysis.summary.layers)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .forEach(([layer, count]) => {
      console.log(`   ${layer}: ${count} entities`);
    });

  // Print texts (especially Hebrew)
  console.log('\n📝 TEXT CONTENT (first 30):');
  analysis.summary.texts.slice(0, 30).forEach((t, i) => {
    console.log(`   ${i + 1}. [${t.layer}] ${t.content}`);
  });

  return analysis;
}

// ===== MAIN =====
async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  APS DWG METADATA EXTRACTOR');
  console.log('  Susya Permit Application #2025021');
  console.log('═══════════════════════════════════════════════════════');

  try {
    const token = await getToken();
    const bucketKey = await ensureBucket(token);

    for (const filePath of FILES) {
      const fullPath = path.resolve(filePath);

      if (!fs.existsSync(fullPath)) {
        console.log(`\n⚠️ File not found: ${fullPath}`);
        continue;
      }

      console.log('\n═══════════════════════════════════════════════════════');
      console.log(`  Processing: ${path.basename(filePath)}`);
      console.log('═══════════════════════════════════════════════════════');

      const { urn, originalName } = await uploadFile(token, bucketKey, fullPath);
      const manifest = await translateToSVF2(token, urn);
      const metadata = await extractMetadata(token, urn);

      // Generate output prefix
      const safeName = originalName.replace(/[^\w.-]/g, '_').substring(0, 50);
      const outputPrefix = `output_${safeName}`;

      // Get thumbnail
      await getThumbnail(token, urn, `${outputPrefix}_thumbnail.png`);

      // Analyze and save
      analyzeResults({ urn, originalName, manifest, ...metadata }, outputPrefix);
    }

    console.log('\n═══════════════════════════════════════════════════════');
    console.log('  ✅ ALL DONE!');
    console.log('═══════════════════════════════════════════════════════');

  } catch (error) {
    console.error('\n❌ ERROR:', error.message);
    process.exit(1);
  }
}

main();
