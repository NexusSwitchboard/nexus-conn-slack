
if [ -z "$1" ]
then
  npm link @nexus-switchboard/nexus-core || exit
elif [ "$1" == "reset" ]
then
  rm -rf ./node_modules || exit
  npm i || exit
fi
