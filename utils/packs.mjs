import fs from "fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import logger from "fancy-log";
import path from "path";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { compilePack, extractPack } from "@foundryvtt/foundryvtt-cli";


/**
 * Folder where the compiled compendium packs should be located relative to the
 * base 5e system folder.
 * @type {string}
 */
const PACK_DEST = "packs";

/**
 * Folder where source JSON files should be located relative to the 5e system folder.
 * @type {string}
 */
const PACK_SRC = "packs/src";


// eslint-disable-next-line
const argv = yargs(hideBin(process.argv))
  .command(packageCommand())
  .help().alias("help", "h")
  .argv;


// eslint-disable-next-line
function packageCommand() {
  return {
    command: "package [action] [pack] [entry]",
    describe: "Manage packages",
    builder: yargs => {
      yargs.positional("action", {
        describe: "The action to perform.",
        type: "string",
        choices: ["unpack", "pack", "clean"]
      });
      yargs.positional("pack", {
        describe: "Name of the pack upon which to work.",
        type: "string"
      });
      yargs.positional("entry", {
        describe: "Name of any entry within a pack upon which to work. Only applicable to extract & clean commands.",
        type: "string"
      });
    },
    handler: async argv => {
      const { action, pack, entry } = argv;
      switch ( action ) {
        case "clean":
          return await cleanPacks(pack, entry);
        case "pack":
          return await compilePacks(pack);
        case "unpack":
          return await extractPacks(pack, entry);
      }
    }
  };
}


/* ----------------------------------------- */
/*  Clean Packs                              */
/* ----------------------------------------- */

/**
 * Removes unwanted flags, permissions, and other data from entries before extracting or compiling.
 * @param {object} data                           Data for a single entry to clean.
 * @param {object} [options={}]
 * @param {boolean} [options.clearSourceId=true]  Should the core sourceId flag be deleted.
 */
function cleanPackEntry(data, { clearSourceId=true }={}) {
  if ( data.ownership ) data.ownership = { default: 0 };
  if ( clearSourceId ) delete data.flags?.core?.sourceId;
  delete data.flags?.importSource;
  delete data.flags?.exportSource;
  if ( data._stats?.lastModifiedBy ) data._stats.lastModifiedBy = "dnd5ebuilder0000";

  // Remove empty entries in flags
  if ( !data.flags ) data.flags = {};
  Object.entries(data.flags).forEach(([key, contents]) => {
    if ( Object.keys(contents).length === 0 ) delete data.flags[key];
  });

  if ( data.system?.activation?.cost === 0 ) data.system.activation.cost = null;
  if ( data.system?.duration?.value === "0" ) data.system.duration.value = "";
  if ( data.system?.target?.value === 0 ) data.system.target.value = null;
  if ( data.system?.target?.width === 0 ) data.system.target.width = null;
  if ( data.system?.range?.value === 0 ) data.system.range.value = null;
  if ( data.system?.range?.long === 0 ) data.system.range.long = null;
  if ( data.system?.uses?.value === 0 ) data.system.uses.value = null;
  if ( data.system?.uses?.max === "0" ) data.system.duration.value = "";
  if ( data.system?.save?.dc === 0 ) data.system.save.dc = null;
  if ( data.system?.capacity?.value === 0 ) data.system.capacity.value = null;
  if ( data.system?.strength === 0 ) data.system.strength = null;

  // Remove mystery-man.svg from Actors
  if ( ["character", "npc"].includes(data.type) && data.img === "icons/svg/mystery-man.svg" ) {
    data.img = "";
    data.prototypeToken.texture.src = "";
  }

  if ( data.effects ) data.effects.forEach(i => cleanPackEntry(i, { clearSourceId: false }));
  if ( data.items ) data.items.forEach(i => cleanPackEntry(i, { clearSourceId: false }));
  if ( data.system?.description?.value ) data.system.description.value = cleanString(data.system.description.value);
  if ( data.label ) data.label = cleanString(data.label);
  if ( data.name ) data.name = cleanString(data.name);
  data.sort = 0;
}


/**
 * Removes invisible whitespace characters and normalizes single- and double-quotes.
 * @param {string} str  The string to be cleaned.
 * @returns {string}    The cleaned string.
 */
function cleanString(str) {
  return str.replace(/\u2060/gu, "").replace(/[‘’]/gu, "'").replace(/[“”]/gu, '"');
}


/**
 * Cleans and formats source JSON files, removing unnecessary permissions and flags and adding the proper spacing.
 * @param {string} [packName]   Name of pack to clean. If none provided, all packs will be cleaned.
 * @param {string} [entryName]  Name of a specific entry to clean.
 *
 * - `npm run build:clean` - Clean all source JSON files.
 * - `npm run build:clean -- classes` - Only clean the source files for the specified compendium.
 * - `npm run build:clean -- classes Barbarian` - Only clean a single item from the specified compendium.
 */
async function cleanPacks(packName, entryName) {
  entryName = entryName?.toLowerCase();
  const folders = fs.readdirSync(PACK_SRC, { withFileTypes: true }).filter(file =>
    file.isDirectory() && ( !packName || (packName === file.name) )
  );

  /**
   * Walk through directories to find JSON files.
   * @param {string} directoryPath
   * @yields {string}
   */
  async function* _walkDir(directoryPath) {
    const directory = await readdir(directoryPath, { withFileTypes: true });
    for ( const entry of directory ) {
      const entryPath = path.join(directoryPath, entry.name);
      if ( entry.isDirectory() ) yield* _walkDir(entryPath);
      else if ( path.extname(entry.name) === ".json" ) yield entryPath;
    }
  }

  for ( const folder of folders ) {
    logger.info(`Cleaning pack ${folder.name}`);
    for await ( const src of _walkDir(path.join(PACK_SRC, folder.name)) ) {
      const json = JSON.parse(await readFile(src, { encoding: "utf8" }));
      if ( entryName && (entryName !== json.name.toLowerCase()) ) continue;
      cleanPackEntry(json);
      fs.rmSync(src, { force: true });
      writeFile(src, `${JSON.stringify(json, null, 2)}\n`, { mode: 0o664 });
    }
  }
}


/* ----------------------------------------- */
/*  Compile Packs                            */
/* ----------------------------------------- */

/**
 * Compile the source JSON files into compendium packs.
 * @param {string} [packName]       Name of pack to compile. If none provided, all packs will be packed.
 *
 * - `npm run build:db` - Compile all JSON files into their LevelDB files.
 * - `npm run build:db -- classes` - Only compile the specified pack.
 */
async function compilePacks(packName) {
  // Determine which source folders to process
  const folders = fs.readdirSync(PACK_SRC, { withFileTypes: true }).filter(file =>
    file.isDirectory() && ( !packName || (packName === file.name) )
  );

  for ( const folder of folders ) {
    const src = path.join(PACK_SRC, folder.name);
    const dest = path.join(PACK_DEST, folder.name);
    logger.info(`Compiling pack ${folder.name}`);
    await compilePack(src, dest, { recursive: true, log: true, transformEntry: cleanPackEntry });
  }
}


/* ----------------------------------------- */
/*  Extract Packs                            */
/* ----------------------------------------- */

/**
 * Extract the contents of compendium packs to JSON files.
 * @param {string} [packName]       Name of pack to extract. If none provided, all packs will be unpacked.
 * @param {string} [entryName]      Name of a specific entry to extract.
 *
 * - `npm build:json - Extract all compendium LevelDB files into JSON files.
 * - `npm build:json -- classes` - Only extract the contents of the specified compendium.
 * - `npm build:json -- classes Barbarian` - Only extract a single item from the specified compendium.
 */
async function extractPacks(packName, entryName) {
  entryName = entryName?.toLowerCase();

  // Load system.json.
  const system = JSON.parse(fs.readFileSync("./system.json", { encoding: "utf8" }));

  // Determine which source packs to process.
  const packs = system.packs.filter(p => !packName || p.name === packName);

  for ( const packInfo of packs ) {
    const dest = path.join(PACK_SRC, packInfo.name);
    logger.info(`Extracting pack ${packInfo.name}`);

    const folders = {};
    await extractPack(packInfo.path, dest, {
      log: false, documentType: packInfo.type, transformEntry: entry => {
        if ( entry._key.startsWith("!folders") ) {
          folders[entry._id] = { name: slugify(entry.name), folder: entry.folder };
          folders[entry._id].path = `${folders[entry._id].name}/`;
        }
        return false;
      }
    });
    for ( const folder of Object.values(folders) ) {
      let parent = folder.folder;
      while ( parent ) {
        const parentData = folders[parent];
        if ( parentData ) folder.path = `${parentData.name}/${folder.path}`;
        parent = parentData?.parent;
      }
    }

    await extractPack(packInfo.path, dest, {
      log: true, documentType: packInfo.type, transformEntry: entry => {
        if ( entryName && (entryName !== entry.name.toLowerCase()) ) return false;
        cleanPackEntry(entry);
      }, transformName: entry => {
        if ( entry._id in folders ) return `${folders[entry._id].path}_folder.json`;
        const outputName = slugify(entry.name);
        return path.join(folders[entry.folder]?.path ?? "", `${outputName}-${entry._id}.json`);
      }
    });
  }
}


/**
 * Standardize name format.
 * @param {string} name
 * @returns {string}
 */
function slugify(name) {
  return name.toLowerCase().replace("'", "").replace(/[^a-z0-9]+/gi, " ").trim().replace(/\s+|-{2,}/g, "-");
}
