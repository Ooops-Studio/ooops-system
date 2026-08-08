import {spawn} from 'node:child_process'
import {readFile} from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const monorepoConfig = JSON.parse(await readFile('monorepo.config.json', 'utf8'))
const starterManifest = JSON.parse(await readFile(path.join(monorepoConfig.starterPackageDir, 'package.json'), 'utf8'))

await run('node', [
	'./scripts/create-package.mjs',
	'--name',
	'@ooopsstudio/example',
	'--archetype',
	'public-package',
	'--dry-run'
])

await run('node', [
	'./scripts/copy-package-from-repo.mjs',
	'--from',
	`./${monorepoConfig.starterPackageDir}`,
	'--name',
	'@ooopsstudio/copied-demo',
	'--dry-run'
])

await run('node', [
	'./scripts/deprecate-package.mjs',
	'--package',
	starterManifest.name
])

console.log('Package creation and migration tool smoke checks passed.')

function run(command, args) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: process.cwd(),
			stdio: 'inherit',
			env: process.env
		})

		child.on('close', (code) => {
			if (code === 0) {
				resolve()
				return
			}

			reject(new Error(`${command} ${args.join(' ')} failed with exit code ${code}`))
		})
	})
}
