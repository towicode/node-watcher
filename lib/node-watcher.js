var spawn = require('child_process').spawn;
var spawnSync = require('child_process').spawnSync;
var path = require('path');
var chokidarLib = require('chokidar');
var colors = require('colors/safe');
var configPath = '';
var spawnedCommands = [];
var chokidar = null;
var config = {};

RegExp.prototype.toJSON = RegExp.prototype.toString;
Function.prototype.toJSON = function() {
	return this.toString().replace(/\n/g, '');
};

var watcher = function(initialConfig) {
	var noConfigFound = false;

	initialConfig = initialConfig || path.resolve(process.cwd(), 'watcherConfig.js');

	if (initialConfig.constructor === String) {
		var resolvedPath = path.resolve(initialConfig);
		configPath = resolvedPath;

		try {
			config = require(resolvedPath);
		} catch (e) {
			config = {};
			configPath = '';
			noConfigFound = true;
		}
	} else {
		config = initialConfig;
	}

	ensureConfigValues();

	if (noConfigFound) {
		console.log(colors.yellow('Couldn\'t find the config file »' + resolvedPath + '«. Will use default values.'));
		console.log(colors.yellow('Default config values are:'));
		console.log(JSON.stringify(config, null, 2));
		console.log();
	} else {
		if (config.verbosity >= verbosity.normal) {
			console.log(colors.green('Using following config (' + configPath + '):'));
			console.log(JSON.stringify(config, null, 2));
			console.log();
		}
	}

	if (!config.commandsOnChange.length) {
		config.commandsOnChange.push({
			command: ''
		});
	}

	setupCommandsOnStart();
	setupCommandsOnChange();

	process.on('SIGTERM', (function(self) {
		return function() {
			for (var index in spawnedCommands) {
				var command = spawnedCommands[index];

				if (command) {
					command.kill('SIGINT');
				}
			}

			if (chokidar) {
				chokidar.close();
			}

			for (var index in config.commandsOnEnd) {
				spawnCommands(config.commandsOnEnd[index].command, true);
			}
		};
	})(this));

};

var ensureConfigValues = function() {
	config.directory = config.directory || process.cwd();
	config.delay = config.delay || 1000;
	config.ignore = config.ignore || [];
	config.sync = false;
	config.verbosity = config.verbosity || 'normal';
	config.verbosity = verbosity[config.verbosity];
	config.commandsOnStart = config.commandsOnStart || [];
	config.commandsOnChange = config.commandsOnChange || [];
	config.commandsOnEnd = config.commandsOnEnd || [];
};

var setupCommandsOnStart = function() {
	for (var index in config.commandsOnStart) {
		if (config.commandsOnStart[index].command.constructor === String) {
			var delay = config.commandsOnStart[index].delay || 0;

			setTimeout(function(index) {
				var sync = config.commandsOnStart[index].sync !== undefined ? config.commandsOnStart[index].sync : config.sync;
				var commands = spawnCommands(config.commandsOnStart[index].command, sync);

				Array.prototype.push.apply(spawnedCommands, commands);
			}, delay, index);
		} else if (config.commandsOnStart[index].command.constructor === Function) {
			var callbackResult = config.commandsOnStart[index].command();
			var delay = config.commandsOnStart[index].delay || 0;

			setTimeout(function(callbackResult) {
				var sync = config.commandsOnStart[index].sync !== undefined ? config.commandsOnStart[index].sync : config.sync;
				var commands = spawnCommands(callbackResult, sync);

				Array.prototype.push.apply(spawnedCommands, commands);
			}, delay, callbackResult);
		}
	}
};

var setupCommandsOnChange = function() {
	var timeoutID = 0;
	var allEvents = [];

	if (config.commandsOnChange.length) {
		var directoryToWatch = config.directory.indexOf('/') !== 0 ? path.resolve(process.cwd(), config.directory) : config.directory;

		chokidar = chokidarLib.watch(directoryToWatch, {
			ignoreInitial: true,
			ignored: config.ignore
		});

		chokidar.on('all', function(event, path) {
			clearTimeout(timeoutID);
			allEvents.push([event, path]);

			if (configPath && event === 'change' && configPath === path) { // The config file changed
				delete require.cache[configPath];
				config = require(configPath);
				ensureConfigValues();

				if (config.verbosity >= verbosity.normal) {
					console.log(colors.green('Config file changed, reloaded it. The new values are:'));
					console.log(JSON.stringify(config, null, 2));
					console.log();
				}

				allEvents = [];
				return;
			}

			timeoutID = setTimeout(function() {
				if (config.verbosity >= verbosity.verbose) {
					console.log(colors.green('Executing callbacks for the following events:'));
					console.log(JSON.stringify(allEvents, null, 2));
					console.log();
				}

				var commandsWereSpawned = false;

				for (var index in config.commandsOnChange) {
					if (config.commandsOnChange[index].command.constructor === String) {
						var delay = config.commandsOnChange[index].delay || 0;

						setTimeout(function(index) {
							var sync = config.commandsOnChange[index].sync !== undefined ? config.commandsOnChange[index].sync : config.sync;

							spawnCommands(config.commandsOnChange[index].command, sync);
						}, delay, index);

						commandsWereSpawned = config.commandsOnChange[index].command !== '';
					} else if (config.commandsOnChange[index].command.constructor === Function) {
						for (var i = 0; i < allEvents.length; i++) {
							var event = allEvents[i][0];
							var file = allEvents[i][1];
							var callbackResult = config.commandsOnChange[index].command(event, file);

							var delay = config.commandsOnChange[index].delay || 0;
							var sync = config.commandsOnChange[index].sync !== undefined ? config.commandsOnChange[index].sync : config.sync;

							setTimeout(function(callbackResult, sync) {
								spawnCommands(callbackResult, sync);
							}, delay, callbackResult, sync);

							commandsWereSpawned = callbackResult !== '';
						}
					}
				}

				if (!commandsWereSpawned) {
					if (config.verbosity >= verbosity.verbose) {
						console.log(colors.yellow('No callbacks were called.'));
						console.log();
					}
				}

				allEvents = [];
			}, config.delay);
		});
	}
};

var spawnCommands = function(commandString, sync) {
	var parsedCommands = parseCommands(commandString);
	var spawnedCommands = [];

	for (var index in parsedCommands) {
		var parsedCommand = parsedCommands[index];

		if (config.verbosity >= verbosity.normal) {
			console.log(colors.green('Spawning the command') + ' "' + parsedCommand.command + '" ' + colors.green('with the arguments ') + JSON.stringify(parsedCommand.arguments));
			console.log();
		}

		var child;

		if (!sync) {
			child = spawn(parsedCommand.command, parsedCommand.arguments, {
				stdio: 'inherit'
			});

			var onExit = (function(parsedCommand) {
				return function() {
					if (config.verbosity >= verbosity.normal) {
						console.log(colors.green('The command') + ' "' + parsedCommand.command + '" ' + colors.green('with arguments ') + JSON.stringify(parsedCommand.arguments) + colors.green(' exited'));
						console.log();
					}
				};
			})(parsedCommand);

			child.on('exit', onExit);
			child.on('SIGTERM', onExit);
			child.on('SIGINT', onExit);
		} else {
			spawnSync(parsedCommand.command, parsedCommand.arguments, {
				stdio: 'inherit'
			});
		}

		spawnedCommands.push(child);
	}

	return spawnedCommands;
};

var parseCommands = function(commandString) {
	var commands = [];

	if (commandString) {
		var parsedCommand = parseCommand(commandString);

		commands.push({
			command: parsedCommand.command,
			arguments: parsedCommand.arguments
		});

		Array.prototype.push.apply(commands, parseCommands(parsedCommand.remainingString));
	}

	return commands;
};

var parseCommand = function(command) {
	var quoted = false;
	var parsedCommand = {
		command: '',
		arguments: [],
		remainingString: ''
	};

	if (!command) {
		return parsedCommand;
	}

	var checkForArguments = function() {
		var remainingString = command.replace(parsedCommand.command, '').trim();

		if (remainingString.indexOf(';') === 0) {
			parsedCommand.remainingString = remainingString.substring(1).trim();
			return parsedCommand;
		}

		var parsedArguments = parseArguments(remainingString);

		parsedCommand.arguments = parsedArguments.arguments;
		parsedCommand.remainingString = parsedArguments.remainingString;

		return parsedCommand;
	};

	for (var i = 0; i < command.length; i++) {
		var char = command.charAt(i);
		var previousChar = i > 0 ? command.charAt(i - 1) : '';

		if (char === ' ') {
			if (quoted || previousChar === '\\') {
				parsedCommand.command += char;
			} else {
				return checkForArguments();
			}
		} else if (char === '"' || char === '\'') {
			if (quoted) {
				return checkForArguments();
			}

			quoted = true;
		} else if (char === ';' && !quoted) {
			return checkForArguments();
		} else if (char === '&' && previousChar === '&' && !quoted) {
			return checkForArguments();
		} else {
			parsedCommand.command += char;
		}
	}

	return checkForArguments();
};

var parseArguments = function(arguments) {
	var quoted = false;
	var parentheses = 0;
	var brackets = 0;
	var braces = 0;
	var parsedArguments = {
		arguments: [],
		remainingString: ''
	};

	if (!arguments) {
		return parsedArguments;
	}

	var currentArgument = '';

	var addArgument = function() {
		currentArgument = currentArgument.trim();

		if (currentArgument.indexOf('"') === 0 && currentArgument.match(/"$/)) {
			currentArgument = currentArgument.substring(1, currentArgument.length - 1);
		}

		if (currentArgument !== '' && currentArgument !== '&') {
			parsedArguments.arguments.push(currentArgument);
		}

		currentArgument = '';
		quoted = false;
		var parentheses = 0;
		var brackets = 0;
		var braces = 0;
	};

	for (var i = 0; i < arguments.length; i++) {
		var char = arguments[i];
		var previousChar = i > 0 ? arguments.charAt(i - 1) : '';

		if (char === ' ') {
			if (quoted || previousChar === '\\') {
				currentArgument += char;
			} else {
				addArgument();
			}
		} else if (char === '"' || char === '\'') {
			currentArgument += char;

			if (quoted && !parentheses && !brackets && !braces) {
				addArgument();
			} else if (quoted) {
				quoted = false;
			} else {
				quoted = true;
			}
		} else if (char === '(') {
			currentArgument += char;
			parentheses++;

		} else if (char === ')') {
			currentArgument += char;
			parentheses--;

			if (!parentheses && !brackets && !braces && !quoted) {
				addArgument();
			}
		} else if (char === '[') {
			currentArgument += char;
			brackets++;
		} else if (char === ']') {
			currentArgument += char;
			brackets--;

			if (!parentheses && !brackets && !braces && !quoted) {
				addArgument();
			}
		} else if (char === '{') {
			currentArgument += char;
			braces++;
		} else if (char === '}') {
			currentArgument += char;
			braces--;

			if (!parentheses && !brackets && !braces && !quoted) {
				addArgument();
			}
		} else if (char === ';') {
			if (!quoted && !parentheses && !brackets && !braces) {
				addArgument();
				parsedArguments.remainingString = arguments.substring(i + 1).trim();
				return parsedArguments;
			} else {
				currentArgument += char;
			}
		} else if (char === '&' && previousChar === '&') {
			if (!quoted && !parentheses && !brackets && !braces) {
				addArgument();
				parsedArguments.remainingString = arguments.substring(i + 1).trim();
				return parsedArguments;
			} else {
				currentArgument += char;
			}
		} else {
			currentArgument += char;
		}
	}

	if (currentArgument) {
		addArgument();
	}

	return parsedArguments;
};

var verbosity = {
	minimal: 0,
	normal: 1,
	verbose: 2
};

module.exports = watcher;

if (process.env.testing) {
	module.exports.test = {
		parseCommands: parseCommands,
		parseCommand: parseCommand,
		parseArguments: parseArguments,
		spawnCommands: spawnCommands,
		setupCommandsOnStart: setupCommandsOnStart,
		setupCommandsOnChange: setupCommandsOnChange,
		ensureConfigValues: ensureConfigValues
	};
}
