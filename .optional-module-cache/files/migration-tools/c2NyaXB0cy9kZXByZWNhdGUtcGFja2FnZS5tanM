import {spawn} from 'node:child_process'
import {readFile, readdir, writeFile} from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const repoRoot = process.cwd()
const args = parseArgs(process.argv.slice(2))
const packageName = required(args.package, '--package is required')
const message = args.message ?? defaultMessage(packageName)
const execute = args.execute === true
const updateReadme = args['update-readme'] === true
const packageDir = await findPackageDir(packageName)
const manifestPath = path.join(packageDir, 'package.json')
const readmePath = path.join(packageDir, 'README.md')

const pkg = JSON.parse(await readFile(manifestPath, 'utf8'))

if (pkg.name !== packageName) {
	throw new Error(`${relative(manifestPath)} declares "${pkg.name}", expected "${packageName}"`)
}

if (pkg.private === true) {
	throw new Error(`${packageName} is private. npm deprecation only applies to published packages.`)
}

console.log(execute ? 'Deprecating package.' : 'Deprecation dry-run.')
console.log(`- package: ${packageName}`)
console.log(`- message: ${message}`)
console.log('')

if (updateReadme) {
	const readme = await readFile(readmePath, 'utf8')
	const banner = `> Deprecated: ${message}\n\n`

	if (!readme.startsWith('> Deprecated:')) {
		if (execute) {
			await writeFile(readmePath, `${banner}${readme}`)
			console.log(`Updated ${relative(readmePath)} with a deprecation banner.`)
		} else {
			console.log(`[dry-run] Would add a deprecation banner to ${relative(readmePath)}.`)
		}
	}
}

const command = ['npm', 'deprecate', packageName, message]

if (execute) {
	await run(command[0], command.slice(1))
	console.log('npm deprecate completed.')
} else {
	console.log(`[dry-run] Would run: ${command.map(shellQuote).join(' ')}`)
	console.log('')
	console.log('Recommended follow-up:')
	console.log('- Add a Changeset explaining the deprecation.')
	console.log('- Add README migration guidance or replacement package link.')
	console.log('- If the package should stop publishing, remove it from future release changes.')
	console.log('- Archive package-specific issues/milestones after users have a migration path.')
}

function parseArgs(argv) {
	const parsed = {}

	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index]

		if (argument === '--') {
			continue
		}

		if (!argument.startsWith('--')) {
			throw new Error(`Unexpected argument "${argument}"`)
		}

		const [key, inlineValue] = argument.slice(2).split('=')

		if (inlineValue !== undefined) {
			parsed[key] = inlineValue
			continue
		}

		const nextValue = argv[index + 1]

		if (!nextValue || nextValue.startsWith('--')) {
			parsed[key] = true
			continue
		}

		parsed[key] = nextValue
		index += 1
	}

	return parsed
}

function required(value, message) {
	if (!value) {
		throw new Error(message)
	}

	return value
}

function defaultMessage(name) {
	return `${name} is deprecated. Check the package README or changelog for migration guidance.`
}

async function findPackageDir(packageName) {
	const packagesRoot = path.join(repoRoot, 'packages')
	const entries = await readdir(packagesRoot, {withFileTypes: true})

	for (const entry of entries) {
		if (!entry.isDirectory()) {
			continue
		}

		const candidateDir = path.join(packagesRoot, entry.name)
		const candidateManifestPath = path.join(candidateDir, 'package.json')

		try {
			const candidate = JSON.parse(await readFile(candidateManifestPath, 'utf8'))

			if (candidate.name === packageName) {
				return candidateDir
			}
		} catch(error) {
			if (error.code === 'ENOENT') {
				continue
			}

			throw error
		}
	}

	throw new Error(`Could not find a workspace package named "${packageName}" under packages/.`)
}

function shellQuote(value) {
	if (/^[A-Za-z0-9_./:@-]+$/.test(value)) {
		return value
	}

	return `'${value.replaceAll("'", "'\\''")}'`
}

function relative(filePath) {
	return path.relative(repoRoot, filePath)
}

function run(command, commandArgs) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, commandArgs, {
			cwd: repoRoot,
			stdio: 'inherit',
			env: process.env
		})

		child.on('close', (code) => {
			if (code === 0) {
				resolve()
				return
			}

			reject(new Error(`${command} ${commandArgs.join(' ')} failed with exit code ${code}`))
		})
	})
}
