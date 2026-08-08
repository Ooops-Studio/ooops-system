import {spawn} from 'node:child_process'
import path from 'node:path'
import process from 'node:process'

const args = process.argv.slice(2)

if (args.includes('--help') || args.includes('-h')) {
	printHelp()
	process.exit(0)
}

const repoRoot = process.cwd()
const shouldInstall = !args.includes('--skip-install') && !args.includes('--dry-run')
const forwardedArgs = args.filter((argument) => argument !== '--skip-install')

if (shouldInstall) {
	console.log('Installing dependencies...')
	await run('pnpm', ['install'], {cwd: repoRoot, capture: false})
	console.log('')
}

console.log('Bootstrapping template values...')
await run(
	process.execPath,
	[path.join(repoRoot, 'scripts', 'init-template.mjs'), ...forwardedArgs],
	{cwd: repoRoot, capture: false}
)

function printHelp() {
	console.log(`Install dependencies and bootstrap the generated repository in one command.

Usage:
  pnpm bootstrap
  pnpm bootstrap -- --dry-run
  pnpm bootstrap -- --scope acme --repo-owner acme --repo-name platform --workspace-name platform --package-name sdk --package-dir sdk

Options:
  --skip-install         run the bootstrap step without pnpm install
  --dry-run              forward to the bootstrap script without writing files
  --help, -h             show this message

All other flags are forwarded to pnpm init:template.
`)
}

function run(command, args, options) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
			env: process.env
		})

		let stdout = ''
		let stderr = ''

		if (options.capture) {
			child.stdout.on('data', (chunk) => {
				stdout += chunk.toString()
			})

			child.stderr.on('data', (chunk) => {
				stderr += chunk.toString()
			})
		}

		child.on('close', (code) => {
			if (code === 0) {
				resolve({stdout, stderr})
				return
			}

			reject(new Error(`${command} ${args.join(' ')} failed with exit code ${code}`))
		})
	})
}
