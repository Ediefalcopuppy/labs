# Summary

A resource catalog entry is a json object that contains data about a specific resource. A local inventory is a json file that stores an inventory of what resources and blueprints a user has. A blueprint contains a list of resources and ticks needed to build a module. A module is a kepler object that is build with a blueprint and the resources needed.

Later, an inventory should be in one JSON file that contains sections that contain different things such as resources, blueprints, and modules. The inventory should be able to be saved and loaded from a file. The inventory should also be able to be updated with new resources, blueprints, and modules.

I did not split `src/index.ts` into multiple files because all of the current commands should be handled as one file, but later on I will add multiple different files for different specialized functions, such as inventory management.
