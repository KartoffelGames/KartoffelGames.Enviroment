import { CliCommandDescription, CliPackageBlueprintParameter, CliPackageInformation, CliPackages, CliParameter, Console, FileSystem, ICliCommand, ICliPackageBlueprintResolver, Package, PackageInformation, Process, ProcessParameter, Project } from '@kartoffelgames/environment.core';

export class KgCliCommand implements ICliCommand<string> {
    /**
     * Command description.
     */
    public get information(): CliCommandDescription<string> {
        return {
            command: {
                pattern: 'create [blueprint_name] [package_name] --list',
                description: 'Create new package.',
            },
            configuration: {
                name: 'package-blueprint',
                default: '',
            }
        };
    }

    /**
     * Execute command.
     * @param pParameter - Command parameter.
     * @param pBlueprintPackages - All cli packages grouped by type.
     */
    public async run(pParameter: CliParameter, pProject: Project): Promise<void> {
        const lConsole = new Console();

        // Read all available cli packages.
        const lCliPackageList: Array<CliPackageInformation> = Array.from((await new CliPackages(pProject.projectRootDirectory).getCommandPackages()).values());

        // Read all KG_Cli_Blueprint packages informations.
        const lBlueprintList: Map<string, Blueprint> = this.readBlueprintList(lCliPackageList);

        // List blueprints on --list parameter and exit command.
        if (pParameter.parameter.has('list')) {
            // Output all commands.
            lConsole.writeLine('Available blueprints:');
            for (const [lBlueprintName,] of lBlueprintList) {
                lConsole.writeLine(`-- ${lBlueprintName}`);
            }
            return;
        }

        // Output heading.
        lConsole.writeLine('Create Package');

        // Read required parameter.
        let lBlueprintName: string = pParameter.parameter.get('blueprint_name')?.toLowerCase() ?? '';
        if (lBlueprintName === '') {
            lBlueprintName = await lConsole.promt('Bluprint name: ', /^[a-z0-9-]$/);
        }

        // Find blueprint by name.
        const lBlueprint: Blueprint | undefined = lBlueprintList.get(lBlueprintName);
        if (!lBlueprint) {
            throw `Blueprint "${lBlueprintName}" not found.`;
        }

        // Find name. Get from command parameter on promt user.
        const lPackageNameValidation: RegExp = /^(?:@[a-z0-9-*~][a-z0-9-*._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
        let lNewPackageName: string = pParameter.parameter.get('package_name') ?? '';
        if (lNewPackageName === '') {
            lNewPackageName = await lConsole.promt('Package Name: ', lPackageNameValidation);
        }

        // Validate packag name again or for the first time.
        if (!lPackageNameValidation.test(lNewPackageName)) {
            throw 'Package name does not match NPM package name convention';
        }

        // Create blueprint.
        const lNewPackageDirectory: string = await this.createBlueprint(lNewPackageName, lBlueprint, pProject);

        // Update vs code workspaces.
        lConsole.writeLine('Add VsCode Workspace...');
        pProject.addWorkspace(lNewPackageName, lNewPackageDirectory);

        // Read package information of newly created package.
        const lPackageInformation: PackageInformation = pProject.getPackageInformation(lNewPackageName);

        // Add package information to package.json.
        lConsole.writeLine('Set package configuration...');
        pProject.writeCliPackageConfiguration(lPackageInformation, this, () => {
            return lBlueprintName;
        });

        // Update missing information.
        pProject.updatePackageConfiguration(lPackageInformation.packageName);

        // Create process parameter to install all dependencies.
        const lProcessParameters: ProcessParameter = new ProcessParameter(pProject.projectRootDirectory, ['npm', 'install']);

        // Call npm install.
        lConsole.writeLine('Install packages...');
        await new Process().executeInConsole(lProcessParameters);

        // Display init information.
        lConsole.writeLine('Package successfully created.');
    }

    /**
     * Create blueprint files.
     * @param pPackageName - Package name.
     * @param pBlueprint - Blueprint name.
     * @param pCommandParameter - Command parameter.
     * @returns 
     */
    private async createBlueprint(pPackageName: string, pBlueprint: Blueprint, pProject: Project): Promise<string> {
        const lConsole = new Console();

        // Get source and target path of blueprint files.
        const lProjectName: string = pProject.packageToIdName(pPackageName);
        const lTargetPath: string = FileSystem.pathToAbsolute(pProject.projectRootDirectory, 'packages', lProjectName.toLowerCase());

        // Check if package already exists.
        if (pProject.packageExists(pPackageName)) {
            throw `Package "${pPackageName}" already exists.`;
        }

        // Check existing target directory.
        if (FileSystem.exists(lTargetPath)) {
            throw `Target directory "${lTargetPath}" already exists.`;
        }

        // Create blueprint resolver instance.
        const lPackageResolver: ICliPackageBlueprintResolver = await new CliPackages(pProject.projectRootDirectory).createPackagePackageBlueprintResolverInstance(pBlueprint.packageInformation);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const lDecompress: (pTargetFile: string, pSourceDirectory: string) => Promise<void> = require('decompress');

        // Rollback on error.
        try {
            // Copy files.
            lConsole.writeLine('Copy files...');

            // Create target directory.
            FileSystem.createDirectory(lTargetPath);

            // Wait for decompression.
            await lDecompress(Package.resolveToPath(pBlueprint.blueprintFilePath), lTargetPath);

            // Create package parameter.
            const lPackageParameter: CliPackageBlueprintParameter = {
                packageName: pPackageName,
                packageIdName: lProjectName,
                packageDirectory: lTargetPath
            };

            // Execute blueprint after copy handler.
            lConsole.writeLine('Execute blueprint resolver...');
            await lPackageResolver.afterCopy(lPackageParameter, pProject);
        } catch (lError) {
            lConsole.writeLine('ERROR: Try rollback.');

            // Rollback by deleting package directory.
            FileSystem.deleteDirectory(lTargetPath);

            // Rethrow error.
            throw lError;
        }

        return lTargetPath;
    }

    /**
     * Create all package blueprint definition class. 
     * @param pBlueprintPackages - Cli packages.
     */
    private readBlueprintList(pPackages: Array<CliPackageInformation>): Map<string, Blueprint> {
        const lAvailableBlueprint: Map<string, Blueprint> = new Map<string, Blueprint>();

        // Create each package blueprint package.
        for (const lPackage of pPackages) {
            // Skip non package blueprints.
            if (!lPackage.configuration.packageBlueprints) {
                continue;
            }

            // Convert all available blueprints to an absolute path.
            for (const [lBlueprintPackageName, lBlueprintPackagePath] of Object.entries(lPackage.configuration.packageBlueprints.packages)) {
                lAvailableBlueprint.set(lBlueprintPackageName, {
                    packageInformation: lPackage,
                    resolverClass: lPackage.configuration.packageBlueprints.resolveClass,
                    blueprintFilePath: Package.resolveToPath(lPackage.packageName + `/` + lBlueprintPackagePath)
                });
            }
        }

        return lAvailableBlueprint;
    }
}

type Blueprint = {
    packageInformation: CliPackageInformation;
    resolverClass: string;
    blueprintFilePath: string;
};